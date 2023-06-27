import {Socket, createServer} from 'node:net'
import {DataFrame, decodeFrame} from '../src/codec'
import {expectEvent, createAsyncReader, createDeferred} from '../src/util'
import Connection, {ConsumerProps, AsyncMessage, ConsumerStatus} from '../src'
import {PassThrough} from 'node:stream'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function* produceFrames(socket: Socket) {
  const versionHeader = Buffer.from('AMQP\x00\x00\x09\x01')
  const read = createAsyncReader(socket)
  const chunk = await read(8)
  if (chunk.compare(versionHeader))
    throw new Error('expected version header')
  try {
    while (true) yield await decodeFrame(read)
  } catch (err) {
    if (err.code !== 'READ_END') socket.destroy(err)
  }
}

type RabbitNextCB = () => Promise<void|DataFrame>
type ConnectionCallback = (socket: Socket, next: RabbitNextCB) => Promise<void>

async function useFakeServer(cb: ConnectionCallback|Array<ConnectionCallback>) {
  const callbacks = Array.isArray(cb) ? cb : [cb]
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  // t.teardown(() => server.close())
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    throw new Error('expected server addr obj')
  let idx = 0
  server.on('connection', (socket) => {
    const frames = produceFrames(socket)
    let res: Awaited<ReturnType<typeof frames['next']>>
    const next = async () => {
      res = await frames.next()
      return res.value
    }
    callbacks[idx](socket, next).catch(err => {
      server.close()
      socket.destroy()
      throw err
    })
    idx = Math.min(idx + 1, callbacks.length - 1)
  })
  return [addr.port, server] as const
}

interface DeferredMessage extends AsyncMessage {
  resolve(status?: ConsumerStatus): void
  reject(reason: any): void
}

function createIterableConsumer(rabbit: Connection, opt: ConsumerProps) {
  const stream = new PassThrough({objectMode: true})
  const sub = rabbit.createConsumer(opt, (msg) => {
    const dfd = createDeferred()
    stream.write(Object.assign(msg, {
      resolve: dfd.resolve,
      reject: dfd.reject
    }))
    return dfd.promise
  })

  const it: AsyncIterator<DeferredMessage> = stream[Symbol.asyncIterator]()

  const close = sub.close.bind(sub)
  return Object.assign(sub, {
    [Symbol.asyncIterator]() {
      return it
    },
    async read() {
      const res = await it.next()
      if (res.done)
        throw new Error('iterable consumer is closed')
      return res.value
    },
    async close() {
      await close()
      stream.end()
    }
  })
}

export {useFakeServer, sleep, createIterableConsumer}
