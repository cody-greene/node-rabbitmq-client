import test from 'tape'
import {sleep} from './util'
import {createAsyncReader} from '../src/util'
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
