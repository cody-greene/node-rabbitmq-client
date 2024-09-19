import test from 'node:test'
import assert from 'node:assert/strict'
import Connection, {ConsumerHandler} from '../src'
import {expectEvent} from '../src/util'
import {createIterableConsumer} from './util'

const RABBITMQ_URL = process.env.RABBITMQ_URL

test('basic rpc setup', async () => {
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
  const res = await client.send(queue, 'PING')
  assert.equal(res.body, 'PONG', 'got the response')

  await client.close()
  await server.close()
  await rabbit.close()
})

test('rpc failure modes', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_52ef4e140113eb53__'
  const client = rabbit.createRPCClient({
    confirm: true,
    timeout: 10,
    // fail until queue is created
    queues: [{queue, passive: true}]
  })

  // 'setup can fail'
  let err
  try {
    await client.send({routingKey: queue}, '')
  } catch (_err) {
    err = _err
  }
  assert.equal(err.code, 'NOT_FOUND', 'setup failed successfully')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true})
  await ch.close()

  // 'response can timeout'
  try {
    await client.send({routingKey: queue}, '')
  } catch (_err) {
    err = _err
  }
  assert.equal(err.code, 'RPC_TIMEOUT', 'got timeout error')

  // 'can encounter a ChannelError'
  const [r1, r2] = await Promise.allSettled([
    client.send({routingKey: queue}, ''),
    // should fail since the exchange does not exist
    client.send({exchange: '__bc84b490a8dab5a0__', routingKey: queue}, ''),
  ])
  assert.equal(r1.status, 'rejected')
  assert.equal(r1.reason.code, 'RPC_CLOSED', 'channel closed before timeout')
  assert.equal(r2.status, 'rejected')
  assert.equal(r2.reason.code, 'NOT_FOUND', 'caused channel error')

  // 'should still work after a few failures'
  const server = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  })
  const res = await client.send(queue, 'PING')
  assert.equal(res.body, 'PONG')

  await server.close()
  await client.close()
  await rabbit.close()
})

test('rpc retry (maxAttempts)', async () => {
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
  assert.equal(res1.body, 'pong')
  assert.equal(res1.correlationId, '1')

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
  assert.equal(res2.body, 'pong')
  assert.equal(res2.correlationId, '3', 'success on 2nd try')

  // 2 fail
  const [res3] = await Promise.allSettled([
    client.send(queue, 'pong'),
    (async () => {
      const [msg4] = await expectEvent<Parameters<ConsumerHandler>>(server, request)
      assert.equal(msg4.correlationId, '4')
      const [msg5] = await expectEvent<Parameters<ConsumerHandler>>(server, request)
      assert.equal(msg5.correlationId, '5')
    })()
  ])
  assert.equal(res3.status, 'rejected')
  assert.equal(res3.reason.code, 'RPC_TIMEOUT', 'timeout on 2nd try')

  await client.close()
  await server.close()
  await rabbit.close()
})

test('rpc discard late responses', async () => {
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
  assert.equal(m1.body, 'ping')
  await m1.reply('pong')
  m1.resolve()

  const m2 = await server.read()
  assert.equal(m2.body, 'bing')
  await m2.reply('bong')
  m2.resolve()

  const r1 = await sending
  assert.equal(r1.body, 'bong')

  await client.close()
  await server.close()
  await rabbit.close()
})
