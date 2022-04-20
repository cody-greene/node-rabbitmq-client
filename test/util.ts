import EventEmitter from 'events'
import {Socket, createServer} from 'net'
import {DataFrame} from '../src/types'
import {decodeFrame} from '../src/codec'

function expectEvent(emitter: EventEmitter, name: string): Promise<any> {
  return new Promise<void>((resolve) => { emitter.once(name, resolve) })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function* produceFrames(socket: Socket) {
  let chunk: Buffer|null
  let frame: DataFrame
  const versionHeader = Buffer.from('AMQP\x00\x00\x09\x01')
  let first = true
  for await (chunk of socket) {
    while (chunk) {
      if (first) {
        if (chunk.slice(0, 8).compare(versionHeader) !== 0)
          throw new Error('expected version header')
        chunk = chunk.byteLength > 8 ? chunk.slice(8) : null
        first = false
        continue
      }
      [frame, chunk] = decodeFrame(chunk)
      yield frame
    }
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

export {useFakeServer, sleep, expectEvent}
