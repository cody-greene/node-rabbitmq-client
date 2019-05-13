'use strict'

const assert = require('assert')
const spec = require('./spec')

const BIT_POS = [1, 2, 4, 8, 16, 32, 64, 128]
const hasOwn = Object.prototype.hasOwnProperty
const SCRATCH_BUFFER = Buffer.alloc(4 * 1024) // TODO make this configurable
const PROTOCOL_HEADER = Buffer.from('AMQP' + String.fromCharCode(...spec.VERSION))

const TYPE = {
  UINT8: {
    decode(src, offset) {
      return [src.readUInt8(offset), offset + 1]
    },
    encode(out, val, offset) {
      return out.writeUInt8(val, offset)
    }
  },
  UINT16: {
    decode(src, offset) {
      return [src.readUInt16BE(offset), offset + 2]
    },
    encode(out, val, offset) {
      return out.writeUInt16BE(val, offset)
    }
  },
  UINT32: {
    decode(src, offset) {
      return [src.readUInt32BE(offset), offset + 4]
    },
    encode(out, val, offset) {
      return out.writeUInt32BE(val, offset)
    }
  },
  UINT64: {
    decode(src, offset) {
      return [readUInt64BE(src, offset), offset + 8]
    },
    encode: writeUInt64BE
  },
  INT8: {
    decode(src, offset) {
      return [src.readInt8(offset), offset + 1]
    },
    encode(out, val, offset) {
      return out.writeInt8(val, offset)
    }
  },
  INT16: {
    decode(src, offset) {
      return [src.readInt16BE(offset), offset + 2]
    },
    encode(out, val, offset) {
      return out.writeInt16BE(val, offset)
    }
  },
  INT32: {
    decode(src, offset) {
      return [src.readInt32BE(offset), offset + 4]
    },
    encode(out, val, offset) {
      return out.writeInt32BE(val, offset)
    }
  },
  INT64: {
    decode(src, offset) {
      return [readInt64BE(src, offset), offset + 8]
    },
    encode: writeInt64BE
  },
  FLOAT: {
    decode(src, offset) {
      return [src.readFloatBE(offset), offset + 4]
    },
    encode(out, val, offset) {
      return out.writeFloatBE(val, offset)
    }
  },
  DOUBLE: {
    decode(src, offset) {
      return [src.readDoubleBE(offset), offset + 8]
    },
    encode(out, val, offset) {
      //       NaN: 0x7ff80000 00000000
      //  Infinity: 0x7ff00000 00000000
      // -Infinity: 0xfff00000 00000000
      //        -0: 0x80000000 00000000
      return out.writeDoubleBE(val, offset)
    }
  },
  VARBIN32: {
    decode(src, offset) {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.slice(offset + 4, total)
      return [val, total]
    },
    encode(out, val, offset) {
      let len = val ? Buffer.byteLength(val) : 0
      let total = offset + 4 + len
      out.writeUInt32BE(len, offset)
      if (len > 0) out.fill(val, offset + 4, total)
      return total
    }
  },
  DECIMAL: {
    decode(src, offset) {
      return [{
        scale: src.readUInt8(offset),
        value: src.readInt32BE(offset + 1)
      }, offset + 5]
    },
    encode(out, val, offset) {
      out.writeUInt8(val.scale, offset)
      return out.writeInt32BE(val.value, offset + 1)
    }
  },
  BITS: {
    // This decoder is a special case
    // note how it mutates "target" & returns only an offset
    decode(src, keys, target, offset) {
      let totalBytes = Math.ceil(keys.length / 8)
      for (let byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        let byte = src.readUInt8(offset + byteIndex)
        for (let bitIndex = 0; bitIndex < 8 && (byteIndex * 8 + bitIndex) < keys.length; bitIndex++) {
          target[keys[(byteIndex * 8) + bitIndex]] = !!(BIT_POS[bitIndex] & byte[bitIndex])
        }
      }
      return offset + totalBytes
    },
    encode(out, values, offset) {
      let totalBytes = Math.ceil(values.length / 8)
      for (let byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        let byte = 0
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
          if (values[(byteIndex * 8) + bitIndex]) byte += BIT_POS[bitIndex]
        }
        out.writeUInt8(byte, offset + byteIndex)
      }
      return offset + totalBytes
    }
  },
  BOOL: {
    decode(src, offset) {
      return [src.readUInt8(offset) === 1, offset + 1]
    },
    encode(out, val, offset) {
      return out.writeUInt8(val, offset)
    }
  },
  SHORTSTR: {
    decode(src, offset) {
      let total = offset + 1 + src.readUInt8(offset)
      let val = src.toString('utf8', offset + 1, total)
      return [val, total]
    },
    encode(out, val, offset) {
      // truncate long strings
      let len = Math.min(Buffer.byteLength(val), 255)
      out.writeUInt8(len, offset)
      out.write(val, offset + 1, len, 'utf8')
      return 1 + offset + len
    }
  },
  STRING: {
    decode(src, offset) {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.toString('utf8', offset + 4, total)
      return [val, total]
    },
    encode(out, val, offset) {
      // truncate really long strings
      let len = Math.min(Buffer.byteLength(val), 0xffffffff)
      out.writeUInt32BE(len, offset)
      out.write(val, offset + 4, len, 'utf8')
      return 4 + offset + len
    }
  },
  VOID: {
    decode(src, offset) {
      return [null, offset]
    },
    encode(out, val, offset) {
      return offset
    }
  },
  TABLE_VALUE: {
    decode(src, offset) {
      let type = src.readUInt8(offset)
      type = String.fromCharCode(type)
      // eslint-disable-next-line no-use-before-define
      return TABLE_TYPE[type].decode(src, offset + 1)
    },
    encode(out, val, offset) {
      let type = typeof val
      if (type === 'string') {
        offset = out.writeUInt8(83, offset) // S
        offset = TYPE.STRING.encode(out, val, offset)
      }
      else if (type === 'boolean') {
        offset = out.writeUInt8(116, offset) // t
        offset = TYPE.BOOL.encode(out, val, offset)
      }
      else if (type === 'number') {
        // 0x4000000000000 (2^50):
        //   insufficient precision to distinguish floats or ints
        //   e.g. Math.pow(2, 50) + 0.1 === Math.pow(2, 50)
        //   so use INT64 instead
        if (val >= 0x8000000000000000
          || val > -0x4000000000000 && val < 0x4000000000000 && Math.floor(val) !== val) {
          offset = out.writeUInt8(100, offset) // d
          offset = TYPE.DOUBLE.encode(out, val, offset)
        }
        else if (val >= -0x80 && val < 0x80) {
          offset = out.writeUInt8(98, offset) // b
          offset = TYPE.INT8.encode(out, val, offset)
        }
        else if (val >= -0x8000 && val < 0x8000) {
          offset = out.writeUInt8(115, offset) // s
          offset = TYPE.INT16.encode(out, val, offset)
        }
        else if (val >= -0x80000000 && val < 0x80000000) {
          offset = out.writeUInt8(73, offset) // I
          offset = TYPE.INT32.encode(out, val, offset)
        }
        else {
          offset = out.writeUInt8(108, offset) // l
          offset = TYPE.INT64.encode(out, val, offset)
        }
      }
      else if (Array.isArray(val)) {
        offset = out.writeUInt8(65, offset) // A
        offset = TYPE.ARRAY.encode(out, val, offset)
      }
      else if (val === null) {
        offset = out.writeUInt8(86, offset) // V
        offset = TYPE.VOID.encode(out, val, offset)
      }
      else if (type === 'object') {
        offset = out.writeUInt8(70, offset) // F
        offset = TYPE.TABLE.encode(out, val, offset)
      }
      return offset
    }
  },
  ARRAY: {
    decode(src, offset) {
      let [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      let items = []
      let total = data.length
      let index = 0
      var val
      while (index < total) {
        [val, index] = TYPE.TABLE_VALUE.decode(src, offset)
        items.push(val)
      }
      return [items, nextOffset]
    },
    encode(out, val, offset) {
      let start = offset
      for (let index = 0; index < val.length; index++) {
        offset = TYPE.TABLE_VALUE.encode(out, val[index], offset)
      }
      out.writeUInt32BE(offset - start, start)
      return offset
    }
  },
  TABLE_PAIR: {
    decode(src, offset) {
      var key, val
      ;[key, offset] = TYPE.SHORTSTR.decode(src, offset)
      ;[val, offset] = TYPE.TABLE_VALUE.decode(src, offset)
      return [key, val, offset]
    },
    encode(out, key, val, offset) {
      offset = TYPE.SHORTSTR.encode(out, key, offset)
      offset = TYPE.TABLE_VALUE.encode(out, val, offset)
      return offset
    }
  },
  TABLE: {
    decode(src, offset) {
      let [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      let total = data.length
      let table = {}
      let index = 0
      var key, val
      while (index < total) {
        [key, val, index] = TYPE.TABLE_PAIR.decode(data, index)
        table[key] = val
      }
      return [table, nextOffset]
    },
    encode(out, val, offset) {
      let start = offset
      offset += 4
      if (val instanceof Map) for (let pair of val.entries()) {
        if (typeof pair[1] != 'undefined')
          offset = TYPE.TABLE_PAIR.encode(out, pair[0], pair[1], offset)
      }
      else for (let key in val) if (hasOwn.call(val, key) && typeof val[key] != 'undefined') {
        offset = TYPE.TABLE_PAIR.encode(out, key, val[key], offset)
      }
      out.writeUInt32BE(offset - start - 4, start)
      return offset
    }
  },
  METHOD_PAYLOAD: {
    decode: decodeMethodPayload,
    encode: encodeMethodPayload
  },
  HEADER_PAYLOAD: {
    decode(src, offset) {
      let classId = src.readUInt16BE(offset)
      // let weight = src.readUInt16BE(offset + 2) // not used
      let bodySize = readUInt64BE(src, offset + 4)
      let flags = src.readUInt16BE(offset + 12)
      let properties = {}
      offset = offset + 14
      for (let index = 0; index < spec.headers.length; index++) {
        let item = spec.headers[index]
        let mask = 1 << (15 - index)
        let val = null
        if (mask === (flags & mask)) {
          // eslint-disable-next-line no-use-before-define
          [val, offset] = PARAM_TYPE[item.type].decode(src, offset)
          properties[item.alias] = val
        }
      }
      return {classId, bodySize, properties}
    },
    encode(out, {className, bodySize, params}, offset) {
      out.writeUInt16BE(spec.classes.get(className).id, offset)
      out.writeUInt16BE(0, offset + 2)
      writeUInt64BE(out, bodySize, offset + 4)
      let flags = 0
      let flagsOffset = offset + 12
      offset = offset + 14
      for (let index = 0; index < spec.headers.length; index++) {
        let item = spec.headers[index]
        if (params[item.alias] != null) {
          // eslint-disable-next-line no-use-before-define
          offset = PARAM_TYPE[item.type].encode(out, params[item.alias], offset)
          flags += 1 << (15 - index)
        }
      }
      out.writeUInt16BE(flags, flagsOffset)
      return offset
    }
  },
  FRAME: {
    decode: decodeFrame,
    encode: encodeFrame
  }
}

// http://www.rabbitmq.com/amqp-0-9-1-errata.html#section_3
const TABLE_TYPE = {
  t: TYPE.BOOL,
  b: TYPE.INT8,
  B: TYPE.UINT8,
  s: TYPE.INT16,
  u: TYPE.UINT16,
  I: TYPE.INT32,
  i: TYPE.UINT32,
  l: TYPE.INT64,
  f: TYPE.FLOAT,
  d: TYPE.DOUBLE,
  D: TYPE.DECIMAL,
  S: TYPE.STRING,
  A: TYPE.ARRAY,
  T: TYPE.UINT64,
  F: TYPE.TABLE,
  V: TYPE.VOID,
  x: TYPE.VARBIN32,
}

const PARAM_TYPE = {
  // bit: TYPE.BITS, // special case
  long: TYPE.INT32,
  longlong: TYPE.INT64,
  longstr: TYPE.STRING,
  octet: TYPE.UINT8,
  short: TYPE.UINT16,
  shortstr: TYPE.SHORTSTR,
  table: TYPE.TABLE,
  timestamp: TYPE.UINT64,
}

const HEARTBEAT_FRAME = TYPE.FRAME.encode(spec.FRAME_HEARTBEAT, 0, null)

/**
 * Signed 64bit integers
 */
function writeInt64BE(buf, val, offset) {
  // TODO node-v12 Buffer#writeBigInt64BE(value: BigInt, offset?: number)
  if (typeof val == 'number') {
    if (val > 0x7fffffffffff || val < -0x7fffffffffff) {
      throw new TypeError('value is out of bounds')
    }
    buf.writeUIntBE(val > 0 ? 0 : 0xffff, offset, 2) // fill the upper 2 bytes
    buf.writeIntBE(val, offset + 2, 6)
  }
  else {
    throw new TypeError('invalid value; must be a number')
  }
  return offset + 8
}

function readInt64BE(buf, offset) {
  // TODO node-v12 Buffer#readBigInt64BE(offset?: number): BigInt
  // warning: we're actually reading a 48bit number here since BigInts aren't
  //          supported natively, yet
  return buf.readIntBE(offset + 2, 6)
}

/**
 * Unsigned 64bit integers
 */
function writeUInt64BE(buf, val, offset) {
  // TODO node-v12 Buffer#writeBigUInt64BE(value: BigInt, offset?: number)
  if (typeof val == 'number') {
    if (val > 0xffffffffffff || val < 0) {
      throw new TypeError('value is out of bounds')
    }
    buf.writeUIntBE(0, offset, 2) // zero-fill the upper 2 bytes
    buf.writeUIntBE(val, offset + 2, 6)
  }
  else {
    throw new TypeError('invalid value; must be a number')
  }
  return offset + 8
}

function readUInt64BE(buf, offset) {
  // TODO node-v12 Buffer#readBigUInt64BE(offset?: number): BigInt
  // warning: we're actually reading a 48bit number here since BigInts aren't
  //          supported natively, yet
  return buf.readUIntBE(offset + 2, 6)
}

function decodeMethodPayload(src, offset) {
  let classId = src.readUInt16BE(offset)
  let methodId = src.readUInt16BE(offset + 2)
  offset = offset + 4
  let classDef = spec.classes.get(classId)
  assert(classDef != null, 'invalid classId: ' + classId)
  let methodDef = classDef.methods.get(methodId)
  assert(methodDef != null, 'invalid methodId: ' + classId)
  let params = {}
  let bits = null
  for (let index = 0; index < methodDef.params.length; index++) {
    let {alias, type} = methodDef.params[index]
    if (type === 'bit') {
      if (bits == null) bits = [alias]
      else bits.push(alias)
    }
    else {
      if (bits != null) {
        offset = TYPE.BITS.decode(src, bits, params, offset)
        bits = null
      }
      let [value, next] = PARAM_TYPE[type].decode(src, offset)
      params[alias] = value
      offset = next
    }
  }
  if (bits != null) {
    TYPE.BITS.decode(src, bits, params, offset)
  }
  return {
    className: classDef.name,
    methodName: methodDef.name,
    params: params
  }
}

function encodeMethodPayload(out, {className, methodName, params}, offset) {
  let classDef = spec.classes.get(className)
  assert(classDef != null, 'invalid className ' + className)
  let methodDef = classDef.methods.get(methodName)
  assert(classDef != null, 'invalid methodName ' + methodName)
  offset = out.writeUInt16BE(classDef.id, offset)
  offset = out.writeUInt16BE(methodDef.id, offset)
  let bits = null
  for (let index = 0; index < methodDef.params.length; index++) {
    let def = methodDef.params[index]
    let val = params[def.alias]
    if (typeof val == 'undefined') {
      if (typeof def.defaultValue == 'undefined') {
        throw new TypeError(`${className}.${methodName} ${def.alias} (a required param) is undefined`)
      }
      else {
        val = def.defaultValue
      }
    }
    if (def.type === 'bit') {
      // bits must be compressed into octets
      if (bits == null) bits = [val]
      else bits.push(val)
    }
    else {
      if (bits != null) {
        offset = TYPE.BITS.encode(out, bits, offset)
        bits = null
      }
      offset = PARAM_TYPE[def.type].encode(out, val, offset)
    }
  }
  if (bits != null) {
    offset = TYPE.BITS.encode(out, bits, offset)
  }
  return offset
}

/**
 * @param {Buffer} src A chunk of data from the socket
 * @return {Tuple<Frame, Buffer>}
 */
function decodeFrame(src) {
  let type = src.readUInt8(0)
  let channelId = src.readUInt16BE(1)
  let [payload, offset] = TYPE.VARBIN32.decode(src, 3)
  let frameEnd = src.readUInt8(offset)
  if (frameEnd !== spec.FRAME_END) {
    throw new Error('invalid FRAME_END octet: ' + frameEnd)
  }
  let rest = src.length > offset + 1 ? src.slice(offset + 1) : null
  if (type === spec.FRAME_METHOD) {
    try {
      payload = TYPE.METHOD_PAYLOAD.decode(payload, 0)
      return [{
        type: 'method',
        channelId: channelId,
        className: payload.className,
        methodName: payload.methodName,
        fullName: payload.className + '.' + payload.methodName,
        params: payload.params
      }, rest]
    }
    catch (err) {
      if (err instanceof RangeError) {
        throw new Error('invalid method payload')
      }
      throw err
    }
  }
  else if (type === spec.FRAME_HEADER) {
    payload = TYPE.HEADER_PAYLOAD.decode(payload, 0)
    return [{
      type: 'header',
      channelId: channelId,
      classId: payload.classId,
      bodySize: payload.bodySize,
      properties: payload.properties,
    }, rest]
  }
  else if (type === spec.FRAME_BODY) {
    return [{type: 'body', channelId, payload}, rest]
  }
  else if (type === spec.FRAME_HEARTBEAT) {
    return [{type: 'heartbeat'}, rest]
  }
}

/**
 * @param {number} channelId (1, maxChannels)
 * @param {object|Buffer} payload
 * @return {Buffer}
 * @throws {Error | TypeError | RangeError}
 */
function encodeFrame(type, channelId, payload) {
  var payloadSize
  var payloadBuffer = SCRATCH_BUFFER
  if (type === spec.FRAME_METHOD) {
    payloadSize = TYPE.METHOD_PAYLOAD.encode(SCRATCH_BUFFER, payload, 0)
  }
  else if (type === spec.FRAME_HEADER) {
    payloadSize = TYPE.HEADER_PAYLOAD.encode(SCRATCH_BUFFER, payload, 0)
  }
  else if (type === spec.FRAME_BODY) {
    payloadSize = payload.length
    payloadBuffer = payload
  }
  else if (type === spec.FRAME_HEARTBEAT) {
    payloadSize = 0
  }
  else {
    throw new Error('invalid frame type: ' + JSON.stringify(type))
  }
  let out = Buffer.allocUnsafe(8 + payloadSize)
  out.writeUInt8(type, 0)
  out.writeUInt16BE(channelId, 1)
  out.writeUInt32BE(payloadSize, 3)
  payloadBuffer.copy(out, 7, 0, payloadSize)
  out.writeUInt8(spec.FRAME_END, 7 + payloadSize)
  return out
}

function encodeMethod(channelId, className, methodName, params) {
  return TYPE.FRAME.encode(spec.FRAME_METHOD, channelId, {className, methodName, params})
}

/**
 * @param {number} channelId
 * @param {object} params
 * @param {Buffer} body
 */
function encodeMessage(channelId, params, body, maxSize) {
  let totalContentFrames = Math.ceil(body.length / (maxSize - 8)) + 1
  let frames = new Array(totalContentFrames)
  frames[0] = TYPE.FRAME.encode(spec.FRAME_HEADER, channelId,
    {className: 'basic', bodySize: body.length, params})
  for (let index = 1; index < totalContentFrames; index++) {
    let offset = (maxSize - 8) * (index - 1)
    frames[index] = TYPE.FRAME.encode(spec.FRAME_BODY, channelId,
      body.slice(offset, offset + maxSize - 8))
  }
  return frames
}

module.exports = {
  PROTOCOL_HEADER,
  HEARTBEAT_FRAME,
  decodeFrame: TYPE.FRAME.decode,
  encodeMethod,
  encodeMessage,
  TYPE, // for testing
}
