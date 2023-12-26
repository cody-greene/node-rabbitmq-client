import test from 'node:test'
import assert from 'node:assert/strict'
import {sleep} from './util'
import {expectEvent, createAsyncReader, EncoderStream} from '../src/util'
import {Readable, Writable} from 'node:stream'

/** Create a Readable stream with configurable speed */
function stubReadable(data: Buffer, chunkSize: number, delay=1): Readable {
  let offset = 0
  return new Readable({
    read() {
      if (offset >= data.byteLength)
        this.push(null)
      else if (delay > 0)
        sleep(delay).then(() => this.push(data.slice(offset, offset += chunkSize)))
      else
        this.push(data.slice(offset, offset += chunkSize))
    }
  })
}

test('createAsyncReader()', async () => {
  const data = Buffer.from('ec825a689c073e6da3bf34862a1513e0774767a21943bc25', 'hex')
  const stream = stubReadable(data, 4) // 4 bytes per ms (24 bytes total)
  const read = createAsyncReader(stream)

  // can read from a stream
  const b1 = await read(4) // should wait for 1 chunk
  assert.equal(b1.toString('hex'), data.slice(0, 4).toString('hex'),
    'read first chunk')
  // should wait for enough data
  const b3 = await read(12) // should wait for 3 chunks
  assert.equal(b3.toString('hex'), data.slice(4, 16).toString('hex'),
    'read second chunk')
  const b2 = await read(8) // should wait for 2 chunks
  assert.equal(b2.toString('hex'), data.slice(16, 24).toString('hex'),
    'read second chunk')

  const [res] = await Promise.allSettled([read(1)])
  assert.equal(res.status, 'rejected')
  assert.equal(res.reason.code, 'READ_END', 'final read should error')
  assert.equal(stream.readable, false, 'stream is closed')
})

test('createAsyncReader() handles a stream closed with partial data', async () => {
  const data = Buffer.from('010203', 'hex')
  const stream = stubReadable(data, 1)
  const read = createAsyncReader(stream)

  const [res] = await Promise.allSettled([read(4)])
  assert.equal(res.status, 'rejected')
  assert.equal(res.reason.code, 'READ_END', 'read rejected')
  assert.equal(stream.readable, false, 'stream is closed')
})

test('createAsyncReader() handles a destroyed/errored stream', async () => {
  const data = Buffer.from('0102030405', 'hex')
  const stream = stubReadable(data, 1)
  const read = createAsyncReader(stream)

  setTimeout(() => stream.destroy(), 2)

  const [res] = await Promise.allSettled([read(4)])
  assert.equal(res.status, 'rejected')
  assert.equal(res.reason.code, 'READ_END', 'read rejected')
  assert.equal(stream.readable, false, 'stream is closed')
})

class StubSocket extends Writable {
  _cur?: [any, (error?: Error | null) => void]
  _write(chunk: any, enc: unknown, cb: (error?: Error | null) => void) {
    this._cur = [chunk, cb]
  }
  read(): any {
    if (!this._cur) return null
    const [chunk, cb] = this._cur
    this._cur = undefined
    cb()
    return chunk
  }
}

test('EncodeStream', async () => {
  const socket = new StubSocket({objectMode: true, highWaterMark: 2})
  const stream = new EncoderStream<string>(socket)

  // 'should write everything if allowed'
  stream.write(['red', 'orange'].values())
  assert.equal(socket.writableLength, 2)
  assert.equal(socket.read(), 'red')
  assert.equal(socket.writableLength, 1)
  assert.equal(socket.read(), 'orange')
  assert.equal(socket.writableLength, 0)
  assert.equal(stream.writableLength, 0)

  // 'should complete more than one iterator'
  stream.write(['green'].values())
  assert.equal(socket.read(), 'green')

  // 'should pause when encountering back-pressure'
  stream.write(['blue', 'indigo', 'violet'].values())
  assert.equal(socket.writableLength, 2)
  assert.equal(socket.read(), 'blue')
  assert.equal(socket.writableLength, 1, 'no writes until fully drained')
  assert.equal(socket.read(), 'indigo')
  assert.equal(socket.read(), 'violet')
  assert.equal(socket.writableLength, 0)

  // 'should not write at all if the destination is already full'
  stream.write(['thalia', 'calliope'].values())
  assert.equal(socket.writableLength, 2)
  stream.write(['erato'].values())
  assert.equal(socket.writableLength, 2)
  assert.equal(socket.read(), 'thalia')
  assert.equal(socket.read(), 'calliope')
  assert.equal(socket.read(), 'erato')

  await stream.writeAsync(['orpheus'].values())
  assert.equal(socket.read(), 'orpheus', 'writeAsync() works')

  // 'should catch iterator errors'
  stream.write(function*(){
    throw new Error('bad news')
  }())
  const err = await expectEvent(stream, 'error')
  assert.equal(err.message, 'bad news', 'emitted error')
  assert.equal(stream.writable, false, 'stream is dead')
})

test('EncoderStream should stop writing when destroyed', async () => {
  const socket = new StubSocket({objectMode: true, highWaterMark: 2})
  const stream = new EncoderStream<string>(socket)

  stream.write(['red', 'blue', 'green'].values())
  assert.equal(socket.writableLength, 2)
  stream.destroy()
  assert.equal(socket.read(), 'red')
  assert.equal(socket.read(), 'blue')
  assert.equal(socket.read(), null, 'green should not be written')
})
