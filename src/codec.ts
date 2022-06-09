/*
 * This module encodes to, and decodes from, the AMQP binary protocol
 */
import assert from 'node:assert'
import {AMQPConnectionError} from './exception'
import SPEC from './spec'
import type {HeaderFrame, MethodFrame, DataFrame, Decimal, MethodParams, Envelope} from './types'

const hasOwn = Object.prototype.hasOwnProperty
/**
 * Should be large enough to contain a MethodFrame or HeaderFrame
 * TODO make this configurable
 */
const SCRATCH_BUFFER = Buffer.alloc(4 * 1024)
/** @internal */
const PROTOCOL_HEADER = Buffer.from('AMQP' + String.fromCharCode(...SPEC.VERSION))
const EMPTY_OBJ = Object.create(null)

type Decoded<T> = [T, number]

interface CodecType<T=unknown> {
  /** Returns the decoded value & offset+bytesRead */
  decode(src: Buffer, offset: number): [T, number]
  /** Returns offset + bytesWritten */
  encode(out: Buffer, val: T, offset: number): number
}

/** @internal */
const TYPE = {
  UINT8: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt8(offset), offset + 1]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeUInt8(val, offset)
    }
  },
  UINT16: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt16BE(offset), offset + 2]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeUInt16BE(val, offset)
    }
  },
  UINT32: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt32BE(offset), offset + 4]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeUInt32BE(val, offset)
    }
  },
  UINT64: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [Number(src.readBigUint64BE(offset)), offset + 8]
    },
    encode(out: Buffer, val: number|bigint, offset: number) {
      return out.writeBigUint64BE(BigInt(val), offset)
    }
  },
  INT8: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt8(offset), offset + 1]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeInt8(val, offset)
    }
  },
  INT16: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt16BE(offset), offset + 2]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeInt16BE(val, offset)
    }
  },
  INT32: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt32BE(offset), offset + 4]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeInt32BE(val, offset)
    }
  },
  INT64: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [Number(src.readBigInt64BE(offset)), offset + 8]
    },
    encode(out: Buffer, val: number|bigint, offset: number) {
     return out.writeBigInt64BE(BigInt(val), offset)
    }
  },
  FLOAT: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readFloatBE(offset), offset + 4]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeFloatBE(val, offset)
    }
  },
  DOUBLE: {
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readDoubleBE(offset), offset + 8]
    },
    encode(out: Buffer, val: number, offset: number) {
      //       NaN: 0x7ff80000 00000000
      //  Infinity: 0x7ff00000 00000000
      // -Infinity: 0xfff00000 00000000
      //        -0: 0x80000000 00000000
      return out.writeDoubleBE(val, offset)
    }
  },
  VARBIN32: {
    decode(src: Buffer, offset: number): Decoded<Buffer> {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.slice(offset + 4, total)
      return [val, total]
    },
    encode(out: Buffer, val: Buffer, offset: number) {
      let len = val ? Buffer.byteLength(val) : 0
      let total = offset + 4 + len
      out.writeUInt32BE(len, offset)
      if (len > 0) out.fill(val, offset + 4, total)
      return total
    }
  },
  DECIMAL: {
    decode(src: Buffer, offset: number): Decoded<Decimal> {
      return [{
        scale: src.readUInt8(offset),
        value: src.readInt32BE(offset + 1)
      }, offset + 5]
    },
    encode(out: Buffer, val: Decimal, offset: number) {
      out.writeUInt8(val.scale, offset)
      return out.writeInt32BE(val.value, offset + 1)
    }
  },
  BITS: {
    // This decoder is a special case
    // note how it mutates "target" & returns only an offset
    decode(src: Buffer, keys: string[], target: Record<string, unknown>, offset: number): number {
      const totalBytes = Math.ceil(keys.length / 8)
      for (let byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        const byte = src.readUInt8(offset + byteIndex)
        for (let bitIndex = 0; bitIndex < 8 && (byteIndex * 8 + bitIndex) < keys.length; bitIndex++) {
          target[keys[(byteIndex * 8) + bitIndex]] = !!((1 << bitIndex) & byte)
        }
      }
      return offset + totalBytes
    },
    encode(out: Buffer, values: unknown[], offset: number) {
      let totalBytes = Math.ceil(values.length / 8)
      for (let byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        let byte = 0
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
          if (values[(byteIndex * 8) + bitIndex]) byte += 1 << bitIndex
        }
        out.writeUInt8(byte, offset + byteIndex)
      }
      return offset + totalBytes
    }
  },
  BOOL: {
    decode(src: Buffer, offset: number): Decoded<boolean> {
      return [src.readUInt8(offset) === 1, offset + 1]
    },
    encode(out: Buffer, val: boolean, offset: number) {
      return out.writeUInt8(val ? 1 : 0, offset)
    }
  },
  SHORTSTR: {
    decode(src: Buffer, offset: number): Decoded<string> {
      let total = offset + 1 + src.readUInt8(offset)
      let val = src.toString('utf8', offset + 1, total)
      return [val, total]
    },
    encode(out: Buffer, val: string, offset: number) {
      // truncate long strings
      let len = Math.min(Buffer.byteLength(val), 255)
      out.writeUInt8(len, offset)
      out.write(val, offset + 1, len, 'utf8')
      return 1 + offset + len
    }
  },
  STRING: {
    decode(src: Buffer, offset: number): Decoded<string> {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.toString('utf8', offset + 4, total)
      return [val, total]
    },
    encode(out: Buffer, val: string, offset: number) {
      // truncate really long strings
      let len = Math.min(Buffer.byteLength(val), 0xffffffff)
      out.writeUInt32BE(len, offset)
      out.write(val, offset + 4, len, 'utf8')
      return 4 + offset + len
    }
  },
  VOID: {
    decode(src: Buffer, offset: number): Decoded<null> {
      return [null, offset]
    },
    encode(out: Buffer, val: unknown, offset: number) {
      return offset
    }
  },
  TABLE_VALUE: {
    decode(src: Buffer, offset: number): Decoded<unknown> {
      const type = String.fromCharCode(src.readUInt8(offset))
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return TABLE_TYPE[type].decode(src, offset + 1)
    },
    encode(out: Buffer, val: unknown, offset: number) {
      if (typeof val === 'string') {
        offset = out.writeUInt8(83, offset) // S
        offset = TYPE.STRING.encode(out, val, offset)
      } else if (typeof val === 'boolean') {
        offset = out.writeUInt8(116, offset) // t
        offset = TYPE.BOOL.encode(out, val, offset)
      } else if (typeof val === 'number') {
        // 0x4000000000000 (2^50):
        //   insufficient precision to distinguish floats or ints
        //   e.g. Math.pow(2, 50) + 0.1 === Math.pow(2, 50)
        //   so use INT64 instead
        if (val >= 0x8000000000000000
          || val > -0x4000000000000 && val < 0x4000000000000 && Math.floor(val) !== val) {
          offset = out.writeUInt8(100, offset) // d
          offset = TYPE.DOUBLE.encode(out, val, offset)
        } else if (val >= -0x80 && val < 0x80) {
          offset = out.writeUInt8(98, offset) // b
          offset = TYPE.INT8.encode(out, val, offset)
        } else if (val >= -0x8000 && val < 0x8000) {
          offset = out.writeUInt8(115, offset) // s
          offset = TYPE.INT16.encode(out, val, offset)
        } else if (val >= -0x80000000 && val < 0x80000000) {
          offset = out.writeUInt8(73, offset) // I
          offset = TYPE.INT32.encode(out, val, offset)
        } else {
          offset = out.writeUInt8(108, offset) // l
          offset = TYPE.INT64.encode(out, val, offset)
        }
      } else if (typeof val == 'bigint') {
        offset = out.writeUInt8(108, offset) // l
        offset = TYPE.INT64.encode(out, val, offset)
      } else if (Array.isArray(val)) {
        offset = out.writeUInt8(65, offset) // A
        offset = TYPE.ARRAY.encode(out, val, offset)
      } else if (val === null) {
        offset = out.writeUInt8(86, offset) // V
        offset = TYPE.VOID.encode(out, val, offset)
      } else if (typeof val === 'object') {
        offset = out.writeUInt8(70, offset) // F
        offset = TYPE.TABLE.encode(out, val as Record<string, unknown>, offset)
      }
      return offset
    }
  },
  ARRAY: {
    decode(src: Buffer, offset: number): Decoded<unknown[]> {
      const [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      const items = []
      const total = data.length
      let index = 0
      let val
      while (index < total) {
        [val, index] = TYPE.TABLE_VALUE.decode(src, offset)
        items.push(val)
      }
      return [items, nextOffset]
    },
    encode(out: Buffer, val: Array<unknown>, offset: number) {
      const start = offset
      for (let index = 0; index < val.length; index++) {
        offset = TYPE.TABLE_VALUE.encode(out, val[index], offset)
      }
      out.writeUInt32BE(offset - start, start)
      return offset
    }
  },
  TABLE_PAIR: {
    decode(src: Buffer, offset: number) {
      var key, val
      ;[key, offset] = TYPE.SHORTSTR.decode(src, offset)
      ;[val, offset] = TYPE.TABLE_VALUE.decode(src, offset)
      return [key, val, offset] as const
    },
    encode(out: Buffer, key: string, val: unknown, offset: number) {
      offset = TYPE.SHORTSTR.encode(out, key, offset)
      offset = TYPE.TABLE_VALUE.encode(out, val, offset)
      return offset
    }
  },
  TABLE: {
    decode(src: Buffer, offset: number): Decoded<Record<string, unknown>> {
      const [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      const total = data.length
      const table: Record<string, unknown> = {}
      let index = 0
      var key, val
      while (index < total) {
        [key, val, index] = TYPE.TABLE_PAIR.decode(data, index)
        table[key] = val
      }
      return [table, nextOffset]
    },
    encode(out: Buffer, val: Record<string, unknown>, offset: number) {
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
  }
}

// http://www.rabbitmq.com/amqp-0-9-1-errata.html#section_3
const TABLE_TYPE: Record<string, CodecType> = {
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

const PARAM_TYPE: Record<string, CodecType> = {
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

/** @internal */
const HEARTBEAT_FRAME = encodeFrame({type: 'heartbeat', channelId: 0})

function decodeHeader(src: Buffer, offset: number) {
  //const classId = src.readUInt16BE(offset)
  // let weight = src.readUInt16BE(offset + 2) // not used
  // this assumes bodySize is less than Number.MAX_SAFE_INTEGER (8 petabytes)
  const bodySize = Number(src.readBigUint64BE(offset + 4))
  const flags = src.readUInt16BE(offset + 12)
  const fields: Record<string, unknown> = {}
  offset = offset + 14
  for (let index = 0; index < SPEC.headerFields.length; index++) {
    const item = SPEC.headerFields[index]
    const mask = 1 << (15 - index)
    let val = null
    if (mask === (flags & mask)) {
      [val, offset] = PARAM_TYPE[item.type].decode(src, offset)
      fields[item.name] = val
    }
  }
  return {bodySize, fields}
}

function encodeHeader(out: Buffer, {bodySize, fields}: HeaderFrame, offset: number) {
  out.writeUint32BE(0x003c0000, offset)
  //out.writeUInt16BE(classId, offset) always 60 for "basic"
  //out.writeUInt16BE(0, offset + 2)
  out.writeBigUint64BE(BigInt(bodySize), offset + 4)
  let flags = 0
  let flagsOffset = offset + 12
  offset = offset + 14
  for (let index = 0; index < SPEC.headerFields.length; index++) {
    const field = SPEC.headerFields[index]
    if (fields[field.name] != null) {
      offset = PARAM_TYPE[field.type].encode(out, fields[field.name], offset)
      flags += 1 << (15 - index)
    }
  }
  out.writeUInt16BE(flags, flagsOffset)
  return offset
}

function decodeMethodPayload(src: Buffer, offset: number) {
  const id = src.readUint32BE(offset)
  offset = offset + 4
  const methodDef = SPEC.methodById.get(id)
  assert(methodDef != null, 'invalid methodId: ' + id)
  const params: Record<string, unknown> = {}
  let bitKeys = null
  for (const {name, type} of methodDef.params) {
    if (type === 'bit') {
      if (bitKeys == null) bitKeys = [name]
      else bitKeys.push(name)
    } else {
      if (bitKeys != null) {
        offset = TYPE.BITS.decode(src, bitKeys, params, offset)
        bitKeys = null
      }
      const [value, next] = PARAM_TYPE[type].decode(src, offset)
      params[name] = value
      offset = next
    }
  }
  if (bitKeys != null) {
    TYPE.BITS.decode(src, bitKeys, params, offset)
  }
  return {
    fullName: methodDef.name,
    params: methodDef.params.length ? params : undefined
  }
}

function encodeMethodPayload(out: Buffer, {fullName, params}: MethodFrame, offset: number) {
  const methodDef = SPEC.methodByName.get(fullName)
  assert(methodDef != null, 'invalid methodName ' + fullName)
  offset = out.writeUint32BE(methodDef.id, offset)
  let bits = null
  if (params == null)
    params = EMPTY_OBJ
  for (const def of methodDef.params) {
    let val = params[def.name]
    if (typeof val == 'undefined') {
      if (typeof def.defaultValue == 'undefined') {
        throw new TypeError(`${methodDef.name} ${def.name} (a required param) is undefined`)
      } else {
        val = def.defaultValue
      }
    }
    if (def.type === 'bit') {
      // bits must be compressed into octets
      if (bits == null) bits = [val]
      else bits.push(val)
    } else {
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

/** @internal */
async function decodeFrame(read: (bytes: number) => Promise<Buffer>): Promise<DataFrame> {
  const chunk = await read(7)
  const frameTypeId = chunk.readUint8(0)
  const channelId = chunk.readUint16BE(1)
  const frameSize = chunk.readUint32BE(3)
  const payloadBuffer = await read(frameSize + 1)
  if (payloadBuffer[frameSize] !== SPEC.FRAME_END)
    throw new AMQPConnectionError('FRAME_ERROR', 'invalid FRAME_END octet: ' + payloadBuffer[frameSize])
  if (frameTypeId === SPEC.FRAME_METHOD) {
    const payload = decodeMethodPayload(payloadBuffer, 0)
    return {
      type: 'method',
      channelId: channelId,
      fullName: payload.fullName as any,
      params: payload.params
    }
  } else if (frameTypeId === SPEC.FRAME_HEADER) {
    const payload = decodeHeader(payloadBuffer, 0)
    return {
      type: 'header',
      channelId: channelId,
      bodySize: payload.bodySize,
      fields: payload.fields,
    }
  } else if (frameTypeId === SPEC.FRAME_BODY) {
    return {type: 'body', channelId, payload: payloadBuffer.slice(0, -1)}
  } else if (frameTypeId === SPEC.FRAME_HEARTBEAT) {
    return {type: 'heartbeat', channelId: 0}
  } else {
    throw new AMQPConnectionError('FRAME_ERROR', 'invalid data frame')
  }
}

/** @internal */
function encodeFrame(data: DataFrame): Buffer {
  let payloadSize
  let payloadBuffer = SCRATCH_BUFFER
  let frameID: number
  if (data.type === 'method') {
    frameID = SPEC.FRAME_METHOD
    payloadSize = encodeMethodPayload(SCRATCH_BUFFER, data, 0)
  } else if (data.type === 'header') {
    frameID = SPEC.FRAME_HEADER
    payloadSize = encodeHeader(SCRATCH_BUFFER, data, 0)
  } else if (data.type === 'body') {
    frameID = SPEC.FRAME_BODY
    payloadSize = data.payload.byteLength
    payloadBuffer = data.payload
  } else /*if (data.type === 'heartbeat')*/ {
    frameID = SPEC.FRAME_HEARTBEAT
    payloadSize = 0
  }
  const out = Buffer.allocUnsafe(8 + payloadSize)
  out.writeUInt8(frameID, 0)
  out.writeUInt16BE(data.channelId, 1)
  out.writeUInt32BE(payloadSize, 3)
  payloadBuffer.copy(out, 7, 0, payloadSize)
  out.writeUInt8(SPEC.FRAME_END, 7 + payloadSize)
  return out
}

/** @internal */
function* genMethodFrame<T extends keyof MethodParams>(channelId: number, fullName: T, params: MethodParams[T]): Generator<Buffer, void> {
  yield encodeFrame({type: 'method', channelId, fullName, params})
}

/** @internal Allocate DataFrame buffers on demand, right before writing to the socket */
function* genContentFrames(channelId: number, params: Envelope, body: Buffer, frameMax: number): Generator<Buffer, void> {
  yield encodeFrame({
    type: 'method',
    channelId,
    fullName: 'basic.publish',
    params
  })
  const maxSize = frameMax - 8
  const totalContentFrames = Math.ceil(body.length / maxSize)
  const headerFrame = encodeFrame({
    type: 'header',
    channelId,
    bodySize: body.length,
    fields: params
  })
  yield headerFrame
  for (let index = 0; index < totalContentFrames; ++index) {
    const offset = maxSize * index
    yield encodeFrame({
      type: 'body',
      channelId,
      payload: body.slice(offset, offset+maxSize)
    })
  }
}

/** @internal */
export {
  PROTOCOL_HEADER,
  HEARTBEAT_FRAME,
  decodeFrame,
  encodeFrame,
  genMethodFrame,
  genContentFrames,
  TYPE, // for testing
}
