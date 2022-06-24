import test from 'tape'
import Connection from '../src'
import {expectEvent} from './util'

const RABBITMQ_URL = process.env.RABBITMQ_URL

test.onFailure(() => process.exit())

test('basic rpc setup', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_284f68e427a918b2__'
  const client = rabbit.createRPCClient()
  const server = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  })

  await expectEvent(server, 'ready')
  const res = await client.publish(queue, 'PING')
  t.is(res.body, 'PONG', 'got the response')

  await client.close()
  await server.close()
  await rabbit.close()
})

test('rpc failure modes', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_52ef4e140113eb53__'
  const client = rabbit.createRPCClient({
    confirm: true,
    timeout: 10,
    // fail until queue is created
    queues: [{queue, passive: true}]
  })

  t.comment('setup can fail')
  let err
  try {
    await client.publish({routingKey: queue}, '')
  } catch (_err) {
    err = _err
  }
  t.is(err.code, 'NOT_FOUND', 'setup failed successfully')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true})
  await ch.close()

  t.comment('response can timeout')
  try {
    await client.publish({routingKey: queue}, '')
  } catch (_err) {
    err = _err
  }
  t.is(err.code, 'RPC_TIMEOUT', 'got timeout error')

  t.comment('can encounter a ChannelError')
  const [r1, r2] = await Promise.allSettled([
    client.publish({routingKey: queue}, ''),
    // should fail since the exchange does not exist
    client.publish({exchange: '__bc84b490a8dab5a0__', routingKey: queue}, ''),
  ])
  if (r1.status !== 'rejected') return t.fail('expected r1 to fail')
  t.is(r1.reason.code, 'RPC_CLOSED', 'channel closed before timeout')
  if (r2.status !== 'rejected') return t.fail('expected r1 to fail')
  t.is(r2.reason.code, 'NOT_FOUND', 'caused channel error')

  t.comment('should still work after a few failures')
  const server = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  })
  const res = await client.publish(queue, 'PING')
  t.is(res.body, 'PONG')

  await server.close()
  await client.close()
  await rabbit.close()
})
