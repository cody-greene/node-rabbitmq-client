import test from 'tape'
import Connection, {ConsumerHandler} from '../src'
import {expectEvent} from '../src/util'
import {createIterableConsumer} from './util'

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

test('rpc retry (maxAttempts)', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)

  const request = Symbol('request')
  const queue = '__test_f6ad3342820fb0c7'
  const server = rabbit.createConsumer({queue, queueOptions: {exclusive: true}}, (msg, reply) => {
    server.emit(request, [msg, reply])
  })
  await expectEvent(server, 'ready')

  const client = rabbit.createRPCClient({confirm: true, maxAttempts: 2, timeout: 50})

  // 1 success
  const [res1] = await Promise.all([
    client.send(queue, 'ping'),
    expectEvent<Parameters<ConsumerHandler>>(server, request)
      .then(([msg, reply]) => reply('pong'))
  ])
  t.equal(res1.body, 'pong')
  t.equal(res1.correlationId, '1')

  // 1 fail, 1 success
  const [res2] = await Promise.all([
    client.send(queue, 'pong'),
    (async () => {
      await expectEvent<Parameters<ConsumerHandler>>(server, request)
      // ignore msg2
      const [, reply3] = await expectEvent<Parameters<ConsumerHandler>>(server, request)
      await reply3('pong')
    })()
  ])
  t.equal(res2.body, 'pong')
  t.equal(res2.correlationId, '3', 'success on 2nd try')

  // 2 fail
  const [res3] = await Promise.allSettled([
    client.send(queue, 'pong'),
    (async () => {
      const [msg4] = await expectEvent<Parameters<ConsumerHandler>>(server, request)
      t.equal(msg4.correlationId, '4')
      const [msg5] = await expectEvent<Parameters<ConsumerHandler>>(server, request)
      t.equal(msg5.correlationId, '5')
    })()
  ])
  if (res3.status === 'rejected') {
    t.equal(res3.reason.code, 'RPC_TIMEOUT', 'timeout on 2nd try')
  } else {
    t.fail('expected an error')
  }

  await client.close()
  await server.close()
  await rabbit.close()
})

test('rpc discard late responses', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = 'f5f8cf8b737f6cdb'
  const server = createIterableConsumer(rabbit, {
    queue,
    queueOptions: {exclusive: true}
  })

  const client = rabbit.createRPCClient({confirm: true, timeout: 50})

  await Promise.allSettled([
    client.send(queue, 'ping'),
    // this kills the channel
    client.send({exchange: '__bc84b490a8dab5a0__'}, null),
  ])

  const sending = client.send(queue, 'bing')

  const m1 = await server.read()
  t.equal(m1.body, 'ping')
  await m1.reply('pong')
  m1.resolve()

  const m2 = await server.read()
  t.equal(m2.body, 'bing')
  await m2.reply('bong')
  m2.resolve()

  const r1 = await sending
  t.equal(r1.body, 'bong')

  await client.close()
  await server.close()
  await rabbit.close()
})
