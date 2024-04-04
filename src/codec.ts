/*
 * This module encodes to, and decodes from, the AMQP binary protocol
 */
import {AMQPChannelError, AMQPConnectionError} from './exception'

/** @internal AMQP 0091 */
export const PROTOCOL_HEADER = Buffer.from([65, 77, 81, 80, 0, 0, 9, 1])
/** @internal */
export const HEARTBEAT_FRAME = Buffer.from([8, 0, 0, 0, 0, 0, 0, 206])

type Decoded<T> = [T, number]

interface CodecType<T=unknown> {
  /** Byte length of the encoded form */
  sizeof(val: T): number
  /** Returns the decoded value & offset+bytesRead */
  decode(src: Buffer, offset: number): [T, number]
  /** Returns offset + bytesWritten */
  encode(out: Buffer, val: T, offset: number): number
}

/** @ignore */
export enum Cmd {
  /** @internal */
  ConnectionStart = 0x000a000a,
  /** @internal */
  ConnectionStartOK = 0x000a000b,
  /** @internal */
  ConnectionSecure = 0x000a0014,
  /** @internal */
  ConnectionSecureOK = 0x000a0015,
  /** @internal */
  ConnectionTune = 0x000a001e,
  /** @internal */
  ConnectionTuneOK = 0x000a001f,
  /** @internal */
  ConnectionOpen = 0x000a0028,
  /** @internal */
  ConnectionOpenOK = 0x000a0029,
  /** @internal */
  ConnectionClose = 0x000a0032,
  /** @internal */
  ConnectionCloseOK = 0x000a0033,
  /** @internal */
  ConnectionBlocked = 0x000a003c,
  /** @internal */
  ConnectionUnblocked = 0x000a003d,

  /** @internal */
  ChannelOpen = 0x0014000a,
  /** @internal */
  ChannelOpenOK = 0x0014000b,
  /** @internal */
  ChannelClose = 0x00140028,
  /** @internal */
  ChannelCloseOK = 0x00140029,

  ExchangeDeclare = 0x0028000a,
  ExchangeDeclareOK = 0x0028000b,
  ExchangeDelete = 0x00280014,
  ExchangeDeleteOK = 0x00280015,
  ExchangeBind = 0x0028001e,
  ExchangeBindOK = 0x0028001f,
  ExchangeUnbind = 0x00280028,
  ExchangeUnbindOK = 0x00280033,

  QueueDeclare = 0x0032000a,
  QueueDeclareOK = 0x0032000b,
  QueueBind = 0x00320014,
  QueueBindOK = 0x00320015,
  QueuePurge = 0x0032001e,
  QueuePurgeOK = 0x0032001f,
  QueueDelete = 0x00320028,
  QueueDeleteOK = 0x00320029,
  QueueUnbind = 0x00320032,
  QueueUnbindOK = 0x00320033,

  BasicQos = 0x003c000a,
  BasicQosOK = 0x003c000b,
  BasicConsume = 0x003c0014,
  BasicConsumeOK = 0x003c0015,
  BasicCancel = 0x003c001e,
  BasicCancelOK = 0x003c001f,
  BasicPublish = 0x003c0028,
  BasicReturn = 0x003c0032,
  BasicDeliver = 0x003c003c,
  BasicGet = 0x003c0046,
  BasicGetOK = 0x003c0047,
  BasicGetEmpty = 0x003c0048,
  BasicAck = 0x003c0050,
  BasicReject = 0x003c005a,
  BasicRecover = 0x003c006e,
  BasicRecoverOK = 0x003c006f,
  BasicNack = 0x003c0078,

  ConfirmSelect = 0x0055000a,
  ConfirmSelectOK = 0x0055000b,

  TxSelect = 0x005a000a,
  TxSelectOK = 0x005a000b,
  TxCommit = 0x005a0014,
  TxCommitOK = 0x005a0015,
  TxRollback = 0x005a001e,
  TxRollbackOK = 0x005a001f,
}

/** @internal */
export const enum FrameType {
  METHOD = 1,
  HEADER = 2,
  BODY = 3,
  HEARTBEAT = 8
}

/** @internal */
export enum ReplyCode{
  OK = 200,
  CONTENT_TOO_LARGE = 311,
  NO_ROUTE = 312,
  NO_CONSUMERS = 313,
  ACCESS_REFUSED = 403,
  NOT_FOUND = 404,
  RESOURCE_LOCKED = 405,
  PRECONDITION_FAILED = 406,
  CONNECTION_FORCED = 320,
  INVALID_PATH = 402,
  FRAME_ERROR = 501,
  SYNTAX_ERROR = 502,
  COMMAND_INVALID = 503,
  CHANNEL_ERROR = 504,
  UNEXPECTED_FRAME = 505,
  RESOURCE_ERROR = 506,
  NOT_ALLOWED = 530,
  NOT_IMPLEMENTED = 540,
  INTERNAL_ERROR = 541,
}

const FRAME_END = 206

/** Represents a list of boolean properties, encoded as a bitfield */
const BITS = (...keys: string[]) => {
  const totalBytes = Math.ceil(keys.length / 8)
  return {
    sizeof() {
      return totalBytes
    },
    decode(src: Buffer, offset: number): Decoded<Record<string, boolean>> {
      const res: Record<string, boolean> = {}
      for (let byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        const byte = src.readUInt8(offset + byteIndex)
        for (let bitIndex = 0; bitIndex < 8 && (byteIndex * 8 + bitIndex) < keys.length; bitIndex++) {
          res[keys[(byteIndex * 8) + bitIndex]] = !!((1 << bitIndex) & byte)
        }
      }
      return [res, offset + totalBytes]
    },
    encode(out: Buffer, props: Record<string, unknown>, offset: number): number {
      let byteIndex, bitIndex, key, byte
      for (byteIndex = 0; byteIndex < totalBytes; byteIndex++) {
        byte = 0
        for (bitIndex = 0; bitIndex < 8; bitIndex++) {
          key = keys[(byteIndex * 8) + bitIndex]
          if (props[key]) byte += 1 << bitIndex
        }
        out.writeUInt8(byte, offset + byteIndex)
      }
      return offset + totalBytes
    }
  }
}

/** Represents AMQP methods parameters, which are non-null values encoded in a particular order. */
const STRUCT = (def: Array<[key: string, ptype: CodecType] | CodecType>) => ({
  sizeof(props: Record<string, unknown>) {
    let size = 0 // 12
    let field, key, ptype
    for (field of def) {
      if (Array.isArray(field)) {
        [key, ptype] = field
        // TODO check for undefined props at a higher level
        size += ptype.sizeof(props[key])
      } else {
        size += field.sizeof(props)
      }
    }
    return size
  },
  decode(src: Buffer, offset: number): Decoded<Record<string, unknown>> {
    let result: Record<string, any> = {}
    let field, key, ptype, props
    for (field of def) {
      if (Array.isArray(field)) {
        [key, ptype] = field
        ;[props, offset] = ptype.decode(src, offset)
        result[key] = props
      } else {
        [props, offset] = field.decode(src, offset)
        Object.assign(result, props)
      }
    }
    return [result, offset]
  },
  encode(out: Buffer, props: Record<string, unknown>, offset: number) {
    let field, key, ptype
    if (props) for (field of def) {
      if (Array.isArray(field)) {
        [key, ptype] = field
        offset = ptype.encode(out, props[key], offset)
      } else {
        offset = field.encode(out, props, offset)
      }
    }
    return offset
  }
})

/** The AMQP spec says: TABLE field names MUST start with a letter, '$' or '#' and
 * may continue with letters, '$' or '#', digits, or underlines, to a maximum
 * length of 128 characters.
 *
 * RabbitMQ, however, does not seem to enforce this. */
const SHORTSTR = {
  sizeof(val: undefined|string|number){
    const str = val == null ? '' : String(val) // cast from Number
    const len = Math.min(Buffer.byteLength(str), 255)
    return 1 + len
  },
  decode(src: Buffer, offset: number): Decoded<string> {
    const total = offset + 1 + src.readUInt8(offset)
    const val = src.toString('utf8', offset + 1, total)
    return [val, total]
  },
  encode(out: Buffer, val: undefined|string|number, offset: number) {
    const str = val == null ? '' : String(val) // cast from Number
    // truncate long strings
    const len = Math.min(Buffer.byteLength(str), 255)
    out.writeUInt8(len, offset)
    out.write(str, offset + 1, len, 'utf8')
    return 1 + offset + len
  }
}

const TYPE = {
  UINT8: {id: 66,
    sizeof(){ return 1 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt8(offset), offset + 1]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeUInt8(val == null ? 0 : val, offset)
    }
  },
  UINT16: {id: 66,
    sizeof(){ return 2 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt16BE(offset), offset + 2]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeUInt16BE(val == null ? 0 : val, offset)
    }
  },
  UINT32: {id: 105,
    sizeof(){ return 4 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readUInt32BE(offset), offset + 4]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeUInt32BE(val == null ? 0 : val, offset)
    }
  },
  UINT64: {id: 84,
    sizeof(){ return 8 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [Number(src.readBigUint64BE(offset)), offset + 8]
    },
    encode(out: Buffer, val: undefined|number|bigint, offset: number) {
      return out.writeBigUint64BE(BigInt(val == null ? 0 : val), offset)
    }
  },
  INT8: {id: 98,
    sizeof(){ return 1 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt8(offset), offset + 1]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeInt8(val == null ? 0 : val, offset)
    }
  },
  INT16: {id: 115,
    sizeof(){ return 2 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt16BE(offset), offset + 2]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeInt16BE(val == null ? 0 : val, offset)
    }
  },
  INT32: {id: 73,
    sizeof(){ return 4 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readInt32BE(offset), offset + 4]
    },
    encode(out: Buffer, val: undefined|number, offset: number) {
      return out.writeInt32BE(val == null ? 0 : val, offset)
    }
  },
  INT64: {id: 108,
    sizeof(){ return 8 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [Number(src.readBigInt64BE(offset)), offset + 8]
    },
    encode(out: Buffer, val: undefined|number|bigint, offset: number) {
     return out.writeBigInt64BE(BigInt(val == null ? 0 : val), offset)
    }
  },
  FLOAT: {id: 102,
    sizeof(){ return 4 },
    decode(src: Buffer, offset: number): Decoded<number> {
      return [src.readFloatBE(offset), offset + 4]
    },
    encode(out: Buffer, val: number, offset: number) {
      return out.writeFloatBE(val, offset)
    }
  },
  DOUBLE: {id: 100,
    sizeof(){ return 8 },
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
  VARBIN32: {id: 120,
    sizeof(val: Buffer|string|null|undefined) {
      const len = val ? Buffer.byteLength(val) : 0
      return 4 + len
    },
    decode(src: Buffer, offset: number): Decoded<Buffer> {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.slice(offset + 4, total)
      return [val, total]
    },
    encode(out: Buffer, val: Buffer|string|null|undefined, offset: number) {
      if (val) {
        const len = Buffer.byteLength(val)
        offset = out.writeUInt32BE(len, offset)
        if (len > 0) out.fill(val, offset, offset + len)
        return offset + len
      }
      return out.writeUInt32BE(0, offset)
    }
  },
  DECIMAL: {id: 68,
    sizeof(){ return 5 },
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
  BOOL: {id: 116,
    sizeof(){ return 1 },
    decode(src: Buffer, offset: number): Decoded<boolean> {
      return [src.readUInt8(offset) === 1, offset + 1]
    },
    encode(out: Buffer, val: boolean, offset: number) {
      return out.writeUInt8(val ? 1 : 0, offset)
    }
  },
  STRING: {id: 83,
    sizeof(val: undefined|string) {
      if (val == null)
        val = ''
      const len = Math.min(Buffer.byteLength(val), 0xffffffff)
      return 4 + len
    },
    decode(src: Buffer, offset: number): Decoded<string> {
      let total = offset + 4 + src.readUInt32BE(offset)
      let val = src.toString('utf8', offset + 4, total)
      return [val, total]
    },
    encode(out: Buffer, val: undefined|string, offset: number) {
      if (val == null)
        val = ''
      // truncate really long strings
      let len = Math.min(Buffer.byteLength(val), 0xffffffff)
      out.writeUInt32BE(len, offset)
      out.write(val, offset + 4, len, 'utf8')
      return 4 + offset + len
    }
  },
  VOID: {id: 86,
    sizeof(){ return 0 },
    decode(src: Buffer, offset: number): Decoded<null> {
      return [null, offset]
    },
    encode(out: Buffer, val: unknown, offset: number) {
      return offset
    }
  },
  ARRAY: {id: 65,
    sizeof(arr: Array<unknown>) {
      let bytes = 4
      for (let el of arr) {
        const etype = getBestType(el)
        if (!etype) continue // not encodable
        bytes += 1 + etype.sizeof(el)
      }
      return bytes
    },
    decode(src: Buffer, offset: number): Decoded<unknown[]> {
      const [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      const items = []
      const total = data.length
      let index = 0
      let val
      while (index < total) {
        [val, index] = readSimpleType(data, index)
        items.push(val)
      }
      return [items, nextOffset]
    },
    encode(out: Buffer, val: Array<unknown>, offset: number) {
      const start = offset
      offset += 4
      for (let index = 0; index < val.length; index++) {
        const etype = getBestType(val[index])
        if (!etype) continue // not encodable
        offset = out.writeUInt8(etype.id, offset)
        offset = etype.encode(out, val[index], offset)
      }
      out.writeUInt32BE(offset - start - 4, start)
      return offset
    }
  },
  TABLE: {id: 70,
    sizeof(props: Record<string, unknown>) {
      let bytes = 4
      const it = props instanceof Map ? props.entries()
        : props != null ? Object.entries(props) : []
      for (const [k, v] of it) {
        if (typeof v != 'undefined') {
          const etype = getBestType(v)
          if (!etype) continue // not encodable
          bytes += SHORTSTR.sizeof(String(k)) + 1 + etype.sizeof(v)
        }
      }
      return bytes
    },
    decode(src: Buffer, offset: number): Decoded<Record<string, unknown>> {
      const [data, nextOffset] = TYPE.VARBIN32.decode(src, offset)
      const total = data.length
      const table: Record<string, unknown> = {}
      let index = 0
      let key, val
      while (index < total) {
        [key, index] = SHORTSTR.decode(data, index)
        ;[val, index] = readSimpleType(data, index)
        table[key] = val
      }
      return [table, nextOffset]
    },
    encode(out: Buffer, val: undefined|Record<string, unknown>, offset: number) {
      let start = offset
      offset += 4
      const it = val instanceof Map ? val.entries()
        : val != null ? Object.entries(val) : []
      for (const [k, v] of it) {
        if (typeof v != 'undefined') {
          const etype = getBestType(v)
          if (!etype) continue // not encodable
          offset = SHORTSTR.encode(out, String(k), offset)
          offset = out.writeUInt8(etype.id, offset)
          offset = etype.encode(out, v, offset)
        }
      }
      out.writeUInt32BE(offset - start - 4, start)
      return offset
    }
  }
}

// http://www.rabbitmq.com/amqp-0-9-1-errata.html#section_3
const TYPE_BY_ID = new Map<number, CodecType>(Object.values(TYPE).map(el => [el.id, el]))

const COMMAND_CODECS = [
  {id: Cmd.ConnectionStart, ...STRUCT([
    ['versionMajor', TYPE.UINT8],
    ['versionMinor', TYPE.UINT8],
    ['serverProperties', TYPE.TABLE],
    ['mechanisms', TYPE.STRING],
    ['locales', TYPE.STRING]])},
  {id: Cmd.ConnectionStartOK, ...STRUCT([
    ['clientProperties', TYPE.TABLE],
    ['mechanism', SHORTSTR],
    ['response', TYPE.STRING],
    ['locale', SHORTSTR]])},
  {id: Cmd.ConnectionSecure, ...STRUCT([
    ['challenge', TYPE.STRING]])},
  {id: Cmd.ConnectionSecureOK, ...STRUCT([
    ['response', TYPE.STRING]])},
  {id: Cmd.ConnectionTune, ...STRUCT([
    ['channelMax', TYPE.UINT16],
    ['frameMax', TYPE.INT32],
    ['heartbeat', TYPE.UINT16]])},
  {id: Cmd.ConnectionTuneOK, ...STRUCT([
    ['channelMax', TYPE.UINT16], // 0
    ['frameMax', TYPE.INT32], // 0
    ['heartbeat', TYPE.UINT16]])}, // 0
  {id: Cmd.ConnectionOpen, ...STRUCT([
    ['virtualHost', SHORTSTR], // "/"
    ['rsvp1', SHORTSTR], // ""
    ['rsvp2', TYPE.BOOL]])},
  {id: Cmd.ConnectionOpenOK, ...STRUCT([
    ['knownHosts', SHORTSTR]])}, // ""
  {id: Cmd.ConnectionClose, ...STRUCT([
    ['replyCode', TYPE.UINT16],
    ['replyText', SHORTSTR], // ''
    ['methodId', TYPE.UINT32]])},
  {id: Cmd.ConnectionCloseOK, ...STRUCT([])},
  {id: Cmd.ConnectionBlocked, ...STRUCT([
    ['reason', SHORTSTR]])}, // ""
  {id: Cmd.ConnectionUnblocked, ...STRUCT([])},
  {id: Cmd.ChannelOpen, ...STRUCT([
    ['rsvp1', SHORTSTR]])}, // ""
  {id: Cmd.ChannelOpenOK, ...STRUCT([
    ['rsvp1', TYPE.STRING]])}, // ""
  {id: Cmd.ChannelClose, ...STRUCT([
    ['replyCode', TYPE.UINT16],
    ['replyText', SHORTSTR], // ""
    ['methodId', TYPE.UINT32]])},
  {id: Cmd.ChannelCloseOK, ...STRUCT([])},
  {id: Cmd.ExchangeDeclare, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['exchange', SHORTSTR],
    ['type', SHORTSTR], // direct
    BITS('passive', 'durable', 'autoDelete', 'internal', 'nowait'),
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.ExchangeDeclareOK, ...STRUCT([])},
  {id: Cmd.ExchangeDelete, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['exchange', SHORTSTR],
    BITS('ifUnused', 'nowait')])},
  {id: Cmd.ExchangeDeleteOK, ...STRUCT([])},
  {id: Cmd.ExchangeBind, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['destination', SHORTSTR],
    ['source', SHORTSTR],
    ['routingKey', SHORTSTR], // ""
    ['nowait', TYPE.BOOL],
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.ExchangeBindOK, ...STRUCT([])},
  {id: Cmd.ExchangeUnbind, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['destination', SHORTSTR],
    ['source', SHORTSTR],
    ['routingKey', SHORTSTR], // ""
    ['nowait', TYPE.BOOL],
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.ExchangeUnbindOK, ...STRUCT([])},
  {id: Cmd.QueueDeclare, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    BITS('passive', 'durable', 'exclusive', 'autoDelete', 'nowait'),
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.QueueDeclareOK, ...STRUCT([
    ['queue', SHORTSTR],
    ['messageCount', TYPE.INT32],
    ['consumerCount', TYPE.INT32]])},
  {id: Cmd.QueueBind, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    ['exchange', SHORTSTR],
    ['routingKey', SHORTSTR], // ""
    ['nowait', TYPE.BOOL],
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.QueueBindOK, ...STRUCT([])},
  {id: Cmd.QueuePurge, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    ['nowait', TYPE.BOOL]])},
  {id: Cmd.QueuePurgeOK, ...STRUCT([
    ['messageCount', TYPE.INT32]])},
  {id: Cmd.QueueDelete, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    BITS('ifUnused', 'ifEmpty', 'nowait')])},
  {id: Cmd.QueueDeleteOK, ...STRUCT([
    ['messageCount', TYPE.INT32]])},
  {id: Cmd.QueueUnbind, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    ['exchange', SHORTSTR],
    ['routingKey', SHORTSTR], // ""
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.QueueUnbindOK, ...STRUCT([])},
  {id: Cmd.BasicQos, ...STRUCT([
    ['prefetchSize', TYPE.INT32], // 0
    ['prefetchCount', TYPE.UINT16], // 0
    ['global', TYPE.BOOL]])},
  {id: Cmd.BasicQosOK, ...STRUCT([])},
  {id: Cmd.BasicConsume, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    ['consumerTag', SHORTSTR], // ""
    BITS('noLocal', 'noAck', 'exclusive', 'nowait'),
    ['arguments', TYPE.TABLE]])}, // {}
  {id: Cmd.BasicConsumeOK, ...STRUCT([
    ['consumerTag', SHORTSTR]])},
  {id: Cmd.BasicCancel, ...STRUCT([
    ['consumerTag', SHORTSTR],
    ['nowait', TYPE.BOOL]])},
  {id: Cmd.BasicCancelOK, ...STRUCT([
    ['consumerTag', SHORTSTR]])},
  {id: Cmd.BasicPublish, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['exchange', SHORTSTR], // ""
    ['routingKey', SHORTSTR], // ""
    BITS('mandatory', 'immediate')])},
  {id: Cmd.BasicReturn, ...STRUCT([
    ['replyCode', TYPE.UINT16],
    ['replyText', SHORTSTR], // ""
    ['exchange', SHORTSTR],
    ['routingKey', SHORTSTR]])},
  {id: Cmd.BasicDeliver, ...STRUCT([
    ['consumerTag', SHORTSTR],
    ['deliveryTag', TYPE.INT64],
    ['redelivered', TYPE.BOOL],
    ['exchange', SHORTSTR],
    ['routingKey', SHORTSTR]])},
  {id: Cmd.BasicGet, ...STRUCT([
    ['rsvp1', TYPE.UINT16], // 0
    ['queue', SHORTSTR], // ""
    ['noAck', TYPE.BOOL]])},
  {id: Cmd.BasicGetOK, ...STRUCT([
    ['deliveryTag', TYPE.INT64],
    ['redelivered', TYPE.BOOL],
    ['exchange', SHORTSTR],
    ['routingKey', SHORTSTR],
    ['messageCount', TYPE.INT32]])},
  {id: Cmd.BasicGetEmpty, ...STRUCT([
    ['rsvp1', SHORTSTR]])}, // ""
  {id: Cmd.BasicAck, ...STRUCT([
    ['deliveryTag', TYPE.INT64],
    ['multiple', TYPE.BOOL]])},
  {id: Cmd.BasicReject, ...STRUCT([
    ['deliveryTag', TYPE.INT64],
    ['requeue', TYPE.BOOL]])}, // true
  {id: Cmd.BasicRecover, ...STRUCT([
    ['requeue', TYPE.BOOL]])},
  {id: Cmd.BasicRecoverOK, ...STRUCT([])},
  {id: Cmd.BasicNack, ...STRUCT([
    ['deliveryTag', TYPE.INT64], // 0
    BITS('multiple', 'requeue')])}, // true
  {id: Cmd.ConfirmSelect, ...STRUCT([
    ['nowait', TYPE.BOOL]])},
  {id: Cmd.ConfirmSelectOK, ...STRUCT([])},
  {id: Cmd.TxSelect, ...STRUCT([])},
  {id: Cmd.TxSelectOK, ...STRUCT([])},
  {id: Cmd.TxCommit, ...STRUCT([])},
  {id: Cmd.TxCommitOK, ...STRUCT([])},
  {id: Cmd.TxRollback, ...STRUCT([])},
  {id: Cmd.TxRollbackOK, ...STRUCT([])},
]

const CMD_CODEC_BY_ID = new Map(COMMAND_CODECS.map(struct => [struct.id, struct]))

const CONTENT_PROPS: ReadonlyArray<[key: keyof HeaderFields, type: CodecType, mask: number]> = [
  ['contentType', SHORTSTR, 0x8000],
  ['contentEncoding', SHORTSTR, 0x4000],
  ['headers', TYPE.TABLE, 0x2000],
  ['deliveryMode', TYPE.UINT8, 0x1000],
  ['priority', TYPE.UINT8, 0x0800],
  ['correlationId', SHORTSTR, 0x0400],
  ['replyTo', SHORTSTR, 0x0200],
  ['expiration', SHORTSTR, 0x0100],
  ['messageId', SHORTSTR, 0x0080],
  ['timestamp', TYPE.UINT64, 0x0040],
  ['type', SHORTSTR, 0x0020],
  ['userId', SHORTSTR, 0x0010],
  ['appId', SHORTSTR, 0x0008],
  ['clusterId', SHORTSTR, 0x0004],
]

/** @internal */
export async function decodeFrame(read: (bytes: number) => Promise<Buffer>): Promise<DataFrame> {
  const chunk = await read(7)
  const frameTypeId = chunk.readUint8(0)
  const channelId = chunk.readUint16BE(1)
  const frameSize = chunk.readUint32BE(3)
  const payloadBuffer = await read(frameSize + 1)
  if (payloadBuffer[frameSize] !== FRAME_END)
    throw new AMQPConnectionError('FRAME_ERROR', 'invalid FRAME_END octet: ' + payloadBuffer[frameSize])
  if (frameTypeId === FrameType.METHOD) {
    const id = payloadBuffer.readUInt32BE(0)
    const def = CMD_CODEC_BY_ID.get(id)
    if (def == null) {
      throw new AMQPConnectionError('CODEC', 'invalid AMQP method id: ' + id)
    }
    const res = def.decode(payloadBuffer, 4)
    return {
      type: FrameType.METHOD,
      channelId: channelId,
      methodId: id,
      params: res[0]
    }
  } else if (frameTypeId === FrameType.HEADER) {
    // skip 4 bytes
    const bodySize = Number(payloadBuffer.readBigUint64BE(4))
    const bits = payloadBuffer.readUInt16BE(12)
    let offset = 14
    let fields: Record<string, any> = {}
    let key, ptype, mask, val
    for ([key, ptype, mask] of CONTENT_PROPS) {
      if (bits & mask) {
        [val, offset] = ptype.decode(payloadBuffer, offset)
        fields[key] = val
      }
    }
    return {
      type: FrameType.HEADER,
      channelId: channelId,
      bodySize: bodySize,
      fields: fields
    }
  } else if (frameTypeId === FrameType.BODY) {
    return {type: FrameType.BODY, channelId, payload: payloadBuffer.slice(0, -1)}
  } else if (frameTypeId === FrameType.HEARTBEAT) {
    return {type: FrameType.HEARTBEAT, channelId: 0}
  } else {
    throw new AMQPConnectionError('FRAME_ERROR', 'invalid data frame')
  }
}

/** @internal */
export function encodeFrame(data: DataFrame, maxSize = Infinity): Buffer {
  if (data.type === FrameType.METHOD) {
    const def = CMD_CODEC_BY_ID.get(data.methodId)
    if (def == null) {
      throw new AMQPConnectionError('CODEC', 'unknown AMQP method id: ' + data.methodId)
    }
    const paramSize = data.params == null ? 0 : def.sizeof(data.params)
    const frameSize = 4 + paramSize
    if (frameSize > maxSize) {
      throw new AMQPChannelError('CODEC', `frame size of ${frameSize} bytes exceeds maximum of ${maxSize}`)
    }
    const buf = Buffer.allocUnsafe(12 + paramSize)
    let offset = buf.writeUInt8(FrameType.METHOD, 0)
    offset = buf.writeUInt16BE(data.channelId, offset)
    offset = buf.writeUInt32BE(frameSize, offset)
    offset = buf.writeUInt32BE(data.methodId, offset)
    if (data.params != null)
      offset = def.encode(buf, data.params, offset)
    buf.writeUInt8(FRAME_END, offset)
    return buf
  } else if (data.type === FrameType.HEADER) {
    let paramSize = 0
    let bits = 0
    let key, ptype, mask, val
    for ([key, ptype, mask] of CONTENT_PROPS) {
      val = data.fields[key]
      if (val != null) {
        paramSize += ptype.sizeof(val)
        bits |= mask
      }
    }
    const frameSize = 14 + paramSize
    if (frameSize > maxSize) {
      throw new AMQPChannelError('CODEC', `frame size of ${frameSize} bytes exceeds maximum of ${maxSize}`)
    }
    const buf = Buffer.allocUnsafe(22 + paramSize)
    let offset = buf.writeUInt8(FrameType.HEADER, 0)
    offset = buf.writeUInt16BE(data.channelId, offset)
    offset = buf.writeUInt32BE(frameSize, offset)
    offset = buf.writeUInt32BE(0x003c0000, offset)
    offset = buf.writeBigUInt64BE(BigInt(data.bodySize), offset)
    offset = buf.writeUInt16BE(bits, offset)
    for ([key, ptype] of CONTENT_PROPS) {
      val = data.fields[key]
      if (val != null) {
        offset = ptype.encode(buf, val, offset)
      }
    }
    buf.writeUInt8(FRAME_END, offset) // frame end
    return buf
  } else if (data.type === FrameType.BODY) {
    const buf = Buffer.allocUnsafe(8 + data.payload.byteLength)
    let offset = buf.writeUInt8(FrameType.BODY, 0)
    offset = buf.writeUInt16BE(data.channelId, offset)
    offset = buf.writeUInt32BE(data.payload.byteLength, offset)
    offset += data.payload.copy(buf, offset, 0)
    buf.writeUInt8(FRAME_END, offset) // frame end
    return buf
  } else {
    throw new Error('not implemented')
  }
}

/** @internal */
export function* genFrame(frame: MethodFrame, frameMax: number): Generator<Buffer, void> {
  yield encodeFrame(frame, frameMax)
}

/** @internal Allocate DataFrame buffers on demand, right before writing to the socket */
export function* genContentFrames(channelId: number, params: Envelope, body: Buffer, frameMax: number): Generator<Buffer, void> {
  // Immediately encode header frame to catch any codec errors before we send
  // the method frame. If we send the method frame, but can't send the header
  // frame, this will cause a connection-level error and reset. This way the
  // error is contained to the channel-level.
  const methodFrame = encodeFrame({
    type: FrameType.METHOD,
    channelId,
    methodId: Cmd.BasicPublish,
    params
  })
  const headerFrame = encodeFrame({
    type: FrameType.HEADER,
    channelId,
    bodySize: body.length,
    fields: params
  }, frameMax)
  yield methodFrame
  yield headerFrame
  const totalContentFrames = Math.ceil(body.length / frameMax)
  for (let index = 0; index < totalContentFrames; ++index) {
    const offset = frameMax * index
    yield encodeFrame({
      type: FrameType.BODY,
      channelId,
      payload: body.slice(offset, offset+frameMax)
    })
  }
}

function readSimpleType(src: Buffer, offset: number): Decoded<unknown> {
  const id = src.readUInt8(offset)
  const etype = TYPE_BY_ID.get(id)
  if (!etype) {
    throw new Error(`unknown AMQP 0.9.1 type code: ${id}`)
  }
  return etype.decode(src, offset + 1)
}

interface IdentifiedCodecType extends CodecType {
  id: number
}

function getBestType(val: unknown): IdentifiedCodecType|undefined {
  if (typeof val === 'string') {
    return TYPE.STRING
  } else if (typeof val === 'boolean') {
    return TYPE.BOOL
  } else if (typeof val === 'number') {
    // 0x4000000000000 (2^50):
    //   insufficient precision to distinguish floats or ints
    //   e.g. Math.pow(2, 50) + 0.1 === Math.pow(2, 50)
    //   so use INT64 instead
    if (val >= 0x8000000000000000
      || val > -0x4000000000000 && val < 0x4000000000000 && Math.floor(val) !== val) {
      return TYPE.DOUBLE
    } else if (val >= -0x80 && val < 0x80) {
      return TYPE.INT8
    } else if (val >= -0x8000 && val < 0x8000) {
      return TYPE.INT16
    } else if (val >= -0x80000000 && val < 0x80000000) {
      return TYPE.INT32
    } else {
      return TYPE.INT64
    }
  } else if (typeof val == 'bigint') {
    return TYPE.INT64
  } else if (Array.isArray(val)) {
    return TYPE.ARRAY
  } else if (val === null) {
    return TYPE.VOID
  } else if (typeof val === 'object') {
    return TYPE.TABLE
  }
}

/** @ignore */
export interface MethodParams {
  [Cmd.BasicAck]: {
    /** The server-assigned and channel-specific delivery tag */
    deliveryTag?: number,
    /** If set to 1, the delivery tag is treated as "up to and including", so
     * that multiple messages can be acknowledged with a single method. If set
     * to zero, the delivery tag refers to a single message. If the multiple
     * field is 1, and the delivery tag is zero, this indicates acknowledgement
     * of all outstanding messages. */
    multiple?: boolean
  },
  [Cmd.BasicCancel]: {
    consumerTag: string,
    /** @internal */nowait?: boolean
  },
  [Cmd.BasicCancelOK]: {consumerTag: string},
  [Cmd.BasicConsume]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    arguments?: {
      /** https://www.rabbitmq.com/consumer-priority.html */
      'x-priority'?: number,
      /** https://www.rabbitmq.com/ha.html#cancellation */
      'x-cancel-on-ha-failover'?: boolean,
      [k: string]: any
    },
    /** Specifies the identifier for the consumer. The consumer tag is local to
     * a channel, so two clients can use the same consumer tags. If this field
     * is empty the server will generate a unique tag. */
    consumerTag?: string,
    /** Request exclusive consumer access, meaning only this consumer can
     * access the queue. */
    exclusive?: boolean,
    /** If this field is set the server does not expect acknowledgements for
     * messages. That is, when a message is delivered to the client the server
     * assumes the delivery will succeed and immediately dequeues it. This
     * functionality may increase performance but at the cost of reliability.
     * Messages can get lost if a client dies before they are delivered to the
     * application. */
    noAck?: boolean,
    /** If the no-local field is set the server will not send messages to the
     * connection that published them. */
    noLocal?: boolean,
    /** Specifies the name of the queue to consume from. If blank then the last
     * declared queue (on the channel) will be used.*/
    queue?: string,
  },
  [Cmd.BasicConsumeOK]: {consumerTag: string},
  [Cmd.BasicDeliver]: {
    /** Identifier for the consumer, valid within the current channel. */
    consumerTag: string,
    /** The server-assigned and channel-specific delivery tag */
    deliveryTag: number,
    /** Specifies the name of the exchange that the message was originally
     * published to. May be empty, indicating the default exchange. */
    exchange: string,
    /** True if the message has been previously delivered to this or another
     * client. */
    redelivered: boolean,
    /** The routing key name specified when the message was published. */
    routingKey: string
  },
  [Cmd.BasicGet]: {
    /** @internal */rsvp1?: number,
    /** Specifies the name of the queue to consume from. */
    queue?: string,
    /** If this field is set the server does not expect acknowledgements for
     * messages. That is, when a message is delivered to the client the server
     * assumes the delivery will succeed and immediately dequeues it. This
     * functionality may increase performance but at the cost of reliability.
     * Messages can get lost if a client dies before they are delivered to the
     * application. */
    noAck?: boolean
  },
  [Cmd.BasicGetEmpty]: void,
  [Cmd.BasicGetOK]: {
    /** The server-assigned and channel-specific delivery tag */
    deliveryTag: number,
    /** True if the message has been previously delivered to this or another
     * client. */
    redelivered: boolean,
    /** The name of the exchange that the message was originally published to.
     * May be empty, indicating the default exchange. */
    exchange: string,
    /** The routing key name specified when the message was published. */
    routingKey: string,
    /** Number of messages remaining in the queue */
    messageCount: number
  },
  [Cmd.BasicNack]: {
    deliveryTag?: number,
    /** If set to 1, the delivery tag is treated as "up to and including", so
     * that multiple messages can be rejected with a single method. If set to
     * zero, the delivery tag refers to a single message. If the multiple field
     * is 1, and the delivery tag is zero, this indicates rejection of all
     * outstanding messages. */
    multiple?: boolean,
    /** If requeue is true, the server will attempt to requeue
     * the message. If requeue is false or the requeue attempt fails the
     * messages are discarded or dead-lettered. The default should be TRUE,
     * according to the AMQP specification, however this can lead to an endless
     * retry-loop if you're not careful. Messages consumed from a {@link
     * https://www.rabbitmq.com/quorum-queues.html#poison-message-handling |
     * quorum queue} will have the "x-delivery-count" header, allowing you to
     * discard a message after too many attempted deliveries. For classic
     * mirrored queues, or non-mirrored queues, you will need to construct your
     * own mechanism for discarding poison messages.
     * @default true */
    requeue?: boolean
  },
  [Cmd.BasicPublish]: {
    /** @internal */rsvp1?: number,
    /** Specifies the name of the exchange to publish to. The exchange name can
     * be empty, meaning the default exchange. If the exchange name is
     * specified, and that exchange does not exist, the server will raise a
     * channel exception. */
    exchange?: string,
    /** This flag tells the server how to react if the message cannot be routed
     * to a queue consumer immediately. If this flag is set, the server will
     * return an undeliverable message with a Return method. If this flag is
     * zero, the server will queue the message, but with no guarantee that it
     * will ever be consumed. */
    immediate?: string,
    /** This flag tells the server how to react if the message cannot be routed
     * to a queue. If this flag is set, the server will return an unroutable
     * message with a Return method. If this flag is zero, the server silently
     * drops the message. */
    mandatory?: boolean,
    /** Specifies the routing key for the message. The routing key is used for
     * routing messages depending on the exchange configuration. */
    routingKey?: string
  },
  [Cmd.BasicQos]: {
    /** The client can request that messages be sent in advance so that when
     * the client finishes processing a message, the following message is
     * already held locally, rather than needing to be sent down the channel.
     * Prefetching gives a performance improvement. This field specifies the
     * prefetch window size in octets. The server will send a message in
     * advance if it is equal to or smaller in size than the available prefetch
     * size (and also falls into other prefetch limits). May be set to zero,
     * meaning "no specific limit", although other prefetch limits may still
     * apply. The prefetch-size is ignored if the no-ack option is set. */
    prefetchSize?: number,
    /** Specifies a prefetch window in terms of whole messages. This field may
     * be used in combination with the prefetch-size field; a message will only
     * be sent in advance if both prefetch windows (and those at the channel
     * and connection level) allow it. The prefetch-count is ignored if the
     * no-ack option is set. */
    prefetchCount?: number,
    /** RabbitMQ has reinterpreted this field. The original specification said:
     * "By default the QoS settings apply to the current channel only. If this
     * field is set, they are applied to the entire connection." Instead,
     * RabbitMQ takes global=false to mean that the QoS settings should apply
     * per-consumer (for new consumers on the channel; existing ones being
     * unaffected) and global=true to mean that the QoS settings should apply
     * per-channel. */
    global?: boolean
  },
  [Cmd.BasicQosOK]: void,
  [Cmd.BasicRecover]: {
    /** If this field is zero, the message will be redelivered to the original
     * recipient. If this bit is 1, the server will attempt to requeue the
     * message, potentially then delivering it to an alternative subscriber. */
    requeue?: boolean
  },
  [Cmd.BasicRecoverOK]: void,
  [Cmd.BasicReject]: {deliveryTag: number, requeue?: boolean},
  [Cmd.BasicReturn]: {replyCode: number, replyText: string, exchange: string, routingKey: string},

  /** @internal */
  [Cmd.ChannelClose]: {replyCode: number, replyText: string, methodId: number},
  /** @internal */
  [Cmd.ChannelCloseOK]: void,
  /** @internal */
  [Cmd.ChannelOpen]: {rsvp1: string},
  /** @internal */
  [Cmd.ChannelOpenOK]: {rsvp1: string},

  [Cmd.ConfirmSelect]: {nowait?: boolean},
  [Cmd.ConfirmSelectOK]: void,

  /** @internal */
  [Cmd.ConnectionBlocked]: {reason: string},
  /** @internal */
  [Cmd.ConnectionClose]: {methodId: number, replyCode: number, replyText: string},
  /** @internal */
  [Cmd.ConnectionCloseOK]: void,
  /** @internal */
  [Cmd.ConnectionOpen]: {virtualHost: string, rsvp1: string, rsvp2?: boolean},
  /** @internal */
  [Cmd.ConnectionOpenOK]: {knownHosts: string},
  /** @internal */
  [Cmd.ConnectionSecure]: {challenge: string},
  /** @internal */
  [Cmd.ConnectionSecureOK]: {response: string},
  /** @internal */
  [Cmd.ConnectionStart]: {locales: string, mechanisms: string, serverProperties: Record<string, unknown>, versionMajor: number, versionMinor: number},
  /** @internal */
  [Cmd.ConnectionStartOK]: {clientProperties: Record<string, unknown>, locale: string, mechanism: string, response: string},
  /** @internal */
  [Cmd.ConnectionTune]: {channelMax: number, frameMax: number, heartbeat: number},
  /** @internal */
  [Cmd.ConnectionTuneOK]: {channelMax: number, frameMax: number, heartbeat: number},
  /** @internal */
  [Cmd.ConnectionUnblocked]: void,

  [Cmd.ExchangeBind]: {
    /** Specifies the name of the destination exchange to bind. */
    destination: string,
    /** Specifies the name of the source exchange to bind. */
    source: string,
    /** Specifies the routing key for the binding. The routing key is used for
     * routing messages depending on the exchange configuration. Not all
     * exchanges use a routing key - refer to the specific exchange
     * documentation. */
    routingKey?: string,
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    /** A set of arguments for the binding. The syntax and semantics of these
     * arguments depends on the exchange class. */
    arguments?: Record<string, any>
  },
  [Cmd.ExchangeBindOK]: void,
  [Cmd.ExchangeDeclare]: {
    arguments?: {
      /** https://www.rabbitmq.com/ae.html */
      'alternate-exchange'?: string,
      [k: string]: any
    },
    /** If set, the exchange is deleted when all queues have finished using it. */
    autoDelete?: boolean,
    /** If set when creating a new exchange, the exchange will be marked as
     * durable. Durable exchanges remain active when a server restarts.
     * Non-durable exchanges (transient exchanges) are purged if/when a server
     * restarts. */
    durable?: boolean,
    /** Exchange names starting with "amq." are reserved for pre-declared and
     * standardised exchanges. The exchange name consists of a non-empty
     * sequence of these characters: letters, digits, hyphen, underscore,
     * period, or colon. */
    exchange: string,
    /** If set, the exchange may not be used directly by publishers, but only
     * when bound to other exchanges. Internal exchanges are used to construct
     * wiring that is not visible to applications. */
    internal?: boolean,
    /** @internal */nowait?: boolean,
    /** @internal */rsvp1?: number,
    /** If set, the server will reply with Declare-Ok if the exchange already
     * exists with the same name, and raise an error if not. The client can use
     * this to check whether an exchange exists without modifying the server
     * state. When set, all other method fields except name and no-wait are
     * ignored. A declare with both passive and no-wait has no effect.
     * Arguments are compared for semantic equivalence. */
    passive?: boolean,
    /** direct, topic, fanout, or headers: Each exchange belongs to one of a
     * set of exchange types implemented by the server. The exchange types
     * define the functionality of the exchange - i.e. how messages are routed
     * through it.
     * @default "direct" */
    type?: string
  },
  [Cmd.ExchangeDeclareOK]: void,
  [Cmd.ExchangeDelete]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    /** Name of the exchange */
    exchange: string,
    /** If set, the server will only delete the exchange if it has no queue
     * bindings. If the exchange has queue bindings the server does not delete
     * it but raises a channel exception instead. */
    ifUnused?: boolean,
  },
  [Cmd.ExchangeDeleteOK]: void,
  [Cmd.ExchangeUnbind]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    arguments?: Record<string, any>,
    /** Specifies the name of the destination exchange to unbind. */
    destination: string,
    /** Specifies the routing key of the binding to unbind. */
    routingKey?: string
    /** Specifies the name of the source exchange to unbind. */
    source: string
  },
  [Cmd.ExchangeUnbindOK]: void,

  [Cmd.QueueBind]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    arguments?: Record<string, any>,
    /** Name of the exchange to bind to. */
    exchange: string,
    /** Specifies the name of the queue to bind. If blank, then the last
     * declared queue on the channel will be used. */
    queue?: string,
    /** Specifies the routing key for the binding. The routing key is used for
     * routing messages depending on the exchange configuration. Not all
     * exchanges use a routing key - refer to the specific exchange
     * documentation. If the queue name is empty, the server uses the last
     * queue declared on the channel. If the routing key is also empty, the
     * server uses this queue name for the routing key as well. If the queue
     * name is provided but the routing key is empty, the server does the
     * binding with that empty routing key. The meaning of empty routing keys
     * depends on the exchange implementation. */
    routingKey?: string
  },
  [Cmd.QueueBindOK]: void,
  [Cmd.QueueDeclare]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    arguments?: {
      /** Per-Queue Message TTL https://www.rabbitmq.com/ttl.html#per-queue-message-ttl */
      'x-message-ttl'?: number,
      /** Queue Expiry https://www.rabbitmq.com/ttl.html#queue-ttl */
      'x-expires'?: number,
      /** https://www.rabbitmq.com/dlx.html */
      'x-dead-letter-exchange'?: string,
      /** https://www.rabbitmq.com/dlx.html */
      'x-dead-letter-routing-key'?: string,
      /** https://www.rabbitmq.com/maxlength.html */
      'x-max-length'?: number,
      /** https://www.rabbitmq.com/maxlength.html */
      'x-overflow'?: 'drop-head' | 'reject-publish' | 'reject-publish-dlx',
      /** https://www.rabbitmq.com/priority.html */
      'x-max-priority'?: number,
      /** https://www.rabbitmq.com/quorum-queues.html
       * https://www.rabbitmq.com/streams.html */
      'x-queue-type'?: 'quorum' | 'classic' | 'stream',
      [k: string]: any
    },
    /** If set, the queue is deleted when all consumers have finished using it.
     * The last consumer can be cancelled either explicitly or because its
     * channel is closed. If there was no consumer ever on the queue, it won't
     * be deleted. Applications can explicitly delete auto-delete queues using
     * the Delete method as normal. */
    autoDelete?: boolean,
    /** If set when creating a new queue, the queue will be marked as durable.
     * Durable queues remain active when a server restarts. Non-durable queues
     * (transient queues) are purged if/when a server restarts. Note that
     * durable queues do not necessarily hold persistent messages, although it
     * does not make sense to send persistent messages to a transient queue. */
    durable?: boolean,
    /** Exclusive queues may only be accessed by the current connection, and
     * are deleted when that connection closes. Passive declaration of an
     * exclusive queue by other connections are not allowed. */
    exclusive?: boolean,
    /** If set, the server will reply with Declare-Ok if the queue already
     * exists with the same name, and raise an error if not. The client can use
     * this to check whether a queue exists without modifying the server state.
     * When set, all other method fields except name and no-wait are ignored. A
     * declare with both passive and no-wait has no effect. */
    passive?: boolean,
    /** The queue name MAY be empty, in which case the server MUST create a new
     * queue with a unique generated name and return this to the client in the
     * Declare-Ok method. Queue names starting with "amq." are reserved for
     * pre-declared and standardised queues. The queue name can be empty, or a
     * sequence of these characters: letters, digits, hyphen, underscore,
     * period, or colon. */
    queue?: string
  },
  [Cmd.QueueDeclareOK]: {queue: string, messageCount: number, consumerCount: number},
  [Cmd.QueueDelete]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    /** If set, the server will only delete the queue if it has no messages. */
    ifEmpty?: boolean,
    /** If set, the server will only delete the queue if it has no consumers.
     * If the queue has consumers the server does does not delete it but raises
     * a channel exception instead. */
    ifUnused?: boolean,
    /** Specifies the name of the queue to delete. */
    queue?: string
  },
  [Cmd.QueueDeleteOK]: {messageCount: number},
  [Cmd.QueuePurge]: {
    /** @internal */rsvp1?: number,
    /** @internal */nowait?: boolean,
    queue?: string,
  },
  [Cmd.QueuePurgeOK]: {messageCount: number},
  [Cmd.QueueUnbind]: {
    /** @internal */rsvp1?: number,
    arguments?: Record<string, any>,
    /** The name of the exchange to unbind from. */
    exchange: string,
    /** Specifies the name of the queue to unbind. */
    queue?: string,
    /** Specifies the routing key of the binding to unbind. */
    routingKey?: string
  },
  [Cmd.QueueUnbindOK]: void,

  [Cmd.TxCommit]: void,
  [Cmd.TxCommitOK]: void,
  [Cmd.TxRollback]: void,
  [Cmd.TxRollbackOK]: void,
  [Cmd.TxSelect]: void,
  [Cmd.TxSelectOK]: void,
}

/** @internal */
export type MethodFrame<T extends Cmd = Cmd> =
  {[id in Cmd]: {
    type: FrameType.METHOD
    channelId: number
    methodId: id
    params: MethodParams[id]
  }}[T]

/** @internal */
export interface HeaderFrame {
  type: FrameType.HEADER,
  channelId: number,
  bodySize: number,
  fields: HeaderFields
}

/** @internal */
export interface BodyFrame {
  type: FrameType.BODY,
  channelId: number,
  payload: Buffer
}

/** @internal */
export type DataFrame =
  | HeaderFrame
  | MethodFrame
  | BodyFrame
  | {type: FrameType.HEARTBEAT, channelId: 0}

export interface HeaderFields {
  /** MIME content type. e.g. "application/json" */
  contentType?: string,
  /** MIME content encoding. e.g. "gzip" */
  contentEncoding?: string,
  /** Additional user-defined fields */
  headers?: {
    /** https://www.rabbitmq.com/sender-selected.html */
    'CC'?: string[],
    /** https://www.rabbitmq.com/sender-selected.html */
    'BCC'?: string[],
    [k: string]: any
  },
  /** Non-persistent (1) or persistent (2). Use the "durable" field instead,
   * which is just a boolean-typed alias.
   * @internal */
  deliveryMode?: number,
  /** Alias for "deliveryMode". Published message should be saved to
   * disk and should survive server restarts. */
  durable?: boolean
  /** Message priority, 0 to 9. */
  priority?: number,
  /** Application correlation identifier. */
  correlationId?: string,
  /** https://www.rabbitmq.com/direct-reply-to.html */
  replyTo?: string,
  /** Message TTL, in milliseconds. Note that only when expired messages reach
   * the head of a queue will they actually be discarded (or dead-lettered).
   * Setting the TTL to 0 causes messages to be expired upon reaching a queue
   * unless they can be delivered to a consumer immediately. */
  expiration?: string,
  /** Application message identifier. */
  messageId?: string,
  /** Message timestamp in seconds. */
  timestamp?: number,
  /** Message type name. */
  type?: string,
  /** Creating user id. */
  userId?: string,
  /** Creating application id. */
  appId?: string,
  clusterId?: string
}

export type MessageBody = string|Buffer|any

type BasicPublishParams = MethodParams[Cmd.BasicPublish]
export interface Envelope extends HeaderFields, BasicPublishParams {}

type BasicDeliverParams = MethodParams[Cmd.BasicDeliver]
/** May be received after creating a consumer with {@link Channel.basicConsume} */
export interface AsyncMessage extends HeaderFields, BasicDeliverParams {
  body: MessageBody
}
type BasicGetOKParams = MethodParams[Cmd.BasicGetOK]
/** May be recieved in response to {@link Channel.basicGet} */
export interface SyncMessage extends HeaderFields, BasicGetOKParams {
  body: MessageBody
}
type BasicReturnParams = MethodParams[Cmd.BasicReturn]
/** May be received after {@link Channel.basicPublish} mandatory=true or immediate=true */
export interface ReturnedMessage extends HeaderFields, BasicReturnParams {
  body: MessageBody
}

export interface Decimal {scale: number, value: number}
