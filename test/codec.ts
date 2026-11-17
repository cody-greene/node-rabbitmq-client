import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeFrame, decodeFrame, FrameType} from '../src/codec'
import { AMQPConnectionError } from '../src'

function createBufferReader(buf: Buffer): ((bytes: number) => Buffer) {
  let position = 0
  return function(bytes) {
    const chunk = buf.slice(position, position + bytes)
    if (chunk.length !== bytes) {
      throw new AMQPConnectionError('READ_END',
          'stream ended before all bytes received')
    }
    position += bytes
    return chunk
  }
}

test('special number encodings', async () => {
  const encoded = encodeFrame({
    type: FrameType.HEADER,
    channelId: 0,
    bodySize: 0,
    fields: {
      headers: {
        'NaN': NaN,
        'Infinity': Infinity,
        '-Infinity': -Infinity,
        'OVER_OLD_LIMIT': 2**51 + 0.5,
        'BIG_NEGATIVE': -1e20, // lower than minimum int64
        'BIG_UINT': 2n ** 63n,
        'BIGINT_NEGATIVE': -1n,
      }
    },
  })

  const decoded = await decodeFrame(createBufferReader(encoded))
  assert.equal(decoded.type, FrameType.HEADER)
  assert(decoded.fields.headers)

  assert(Number.isNaN(decoded.fields.headers.NaN))
  assert.equal(decoded.fields.headers.Infinity, Infinity)
  assert.equal(decoded.fields.headers['-Infinity'], -Infinity)
  assert.equal(decoded.fields.headers.OVER_OLD_LIMIT, 2251799813685248.5)
  assert.equal(decoded.fields.headers.BIG_NEGATIVE, -100_000_000_000_000_000_000)
  // 9_223_372_036_854_775_808n => 9_223_372_036_854_776_000 rounded when decoded and cast to IEEE-754
  assert.equal(decoded.fields.headers.BIG_UINT, 9_223_372_036_854_776_000)
  assert.equal(decoded.fields.headers.BIGINT_NEGATIVE, -1)
})
