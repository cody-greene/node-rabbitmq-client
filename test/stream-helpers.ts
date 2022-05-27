import test from 'tape'
import {expectEvent, sleep} from './util'
import {createAsyncReader, EncoderStream} from '../src/util'
import {Readable, Writable} from 'stream'

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

test('createAsyncReader()', async (t) => {
  t.plan(5)
  const data = Buffer.from('ec825a689c073e6da3bf34862a1513e0774767a21943bc25', 'hex')
  const stream = stubReadable(data, 4) // 4 bytes per ms (24 bytes total)
  const read = createAsyncReader(stream)

  // can read from a stream
  const b1 = await read(4) // should wait for 1 chunk
  t.is(b1.toString('hex'), data.slice(0, 4).toString('hex'),
    'read first chunk')
  // should wait for enough data
  const b3 = await read(12) // should wait for 3 chunks
  t.is(b3.toString('hex'), data.slice(4, 16).toString('hex'),
    'read second chunk')
  const b2 = await read(8) // should wait for 2 chunks
  t.is(b2.toString('hex'), data.slice(16, 24).toString('hex'),
    'read second chunk')

  try {
    await read(1)
  } catch (err) {
    t.is(err.code, 'READ_END', 'final read should error')
  }
  t.is(stream.readable, false, 'stream is closed')
})

test('createAsyncReader() handles a stream closed with partial data', async (t) => {
  t.plan(2)
  const data = Buffer.from('010203', 'hex')
  const stream = stubReadable(data, 1)
  const read = createAsyncReader(stream)

  try {
    await read(4)
  } catch (err) {
    t.is(err.code, 'READ_END', 'read rejected')
  }
  t.is(stream.readable, false, 'stream is closed')
})

test('createAsyncReader() handles a destroyed/errored stream', async (t) => {
  t.plan(2)
  const data = Buffer.from('0102030405', 'hex')
  const stream = stubReadable(data, 1)
  const read = createAsyncReader(stream)

  setTimeout(() => stream.destroy(), 2)

  try {
    await read(4)
  } catch (err) {
    t.is(err.code, 'READ_END', 'read rejected')
  }
  t.is(stream.readable, false, 'stream is closed')
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

test('EncodeStream', async (t) => {
  const socket = new StubSocket({objectMode: true, highWaterMark: 2})
  const stream = new EncoderStream<string>(socket)

  t.comment('should write everything if allowed')
  stream.write(['red', 'orange'].values())
  t.is(socket.writableLength, 2)
  t.is(socket.read(), 'red')
  t.is(socket.writableLength, 1)
  t.is(socket.read(), 'orange')
  t.is(socket.writableLength, 0)
  t.is(stream.writableLength, 0)

  t.comment('should complete more than one iterator')
  stream.write(['green'].values())
  t.is(socket.read(), 'green')

  t.comment('should pause when encountering back-pressure')
  stream.write(['blue', 'indigo', 'violet'].values())
  t.is(socket.writableLength, 2)
  t.is(socket.read(), 'blue')
  t.is(socket.writableLength, 1, 'no writes until fully drained')
  t.is(socket.read(), 'indigo')
  t.is(socket.read(), 'violet')
  t.is(socket.writableLength, 0)

  t.comment('should not write at all if the destination is already full')
  stream.write(['thalia', 'calliope'].values())
  t.is(socket.writableLength, 2)
  stream.write(['erato'].values())
  t.is(socket.writableLength, 2)
  t.is(socket.read(), 'thalia')
  t.is(socket.read(), 'calliope')
  t.is(socket.read(), 'erato')

  await stream.writeAsync(['orpheus'].values())
  t.is(socket.read(), 'orpheus', 'writeAsync() works')

  t.comment('should catch iterator errors')
  stream.write(function*(){
    throw new Error('bad news')
  }())
  const err = await expectEvent(stream, 'error')
  t.is(err.message, 'bad news', 'emitted error')
  t.is(stream.writable, false, 'stream is dead')
})

test('EncoderStream should stop writing when destroyed', async (t) => {
  const socket = new StubSocket({objectMode: true, highWaterMark: 2})
  const stream = new EncoderStream<string>(socket)

  stream.write(['red', 'blue', 'green'].values())
  t.is(socket.writableLength, 2)
  stream.destroy()
  t.is(socket.read(), 'red')
  t.is(socket.read(), 'blue')
  t.is(socket.read(), null, 'green should not be written')
})
