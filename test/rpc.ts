import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import Connection, {ConsumerHandler} from '../src'
import {expectEvent} from '../src/util'
import {autoTeardown, createIterableConsumer, sleep, useFakeServer} from './util'
import { AsyncMessage, Cmd, DataFrame, encodeFrame, FrameType, MethodFrame } from '../src/codec'

const RABBITMQ_URL = process.env.RABBITMQ_URL

test('basic rpc setup', async () => {
  const rabbit = autoTeardown(new Connection(RABBITMQ_URL))
  const queue = '__test_284f68e427a918b2__'
  const client = autoTeardown(rabbit.createRPCClient())
  const server = autoTeardown(rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  }))

  await expectEvent(server, 'ready')
  const res = await client.send(queue, 'PING')
  assert.equal(res.body, 'PONG', 'got the response')
})

test('rpc can timeout', async () => {
  const rabbit = autoTeardown(new Connection(RABBITMQ_URL))
  const queue = '__test_52ef4e140113eb58__'
  const client = autoTeardown(rabbit.createRPCClient({
    confirm: true,
    timeout: 10,
    queues: [{queue, exclusive: true}]
  }))

  await assert.rejects(client.send({routingKey: queue}, ''), {
    code: 'RPC_TIMEOUT'
  })
})

test('rpc failure modes', async () => {
  const rabbit = autoTeardown(new Connection(RABBITMQ_URL))
  const queue = '__test_52ef4e140113eb53__'
  const client = autoTeardown(rabbit.createRPCClient({
    confirm: true,
    // fail until queue is created
    queues: [{queue, passive: true}]
  }))

  // 'setup can fail'
  let err
  try {
    await client.send({routingKey: queue}, '')
  } catch (_err) {
    err = _err
  }
  assert.equal(err.code, 'NOT_FOUND', 'setup failed successfully')

  await rabbit.queueDeclare({queue, exclusive: true})

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
  const server = autoTeardown(rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  }))
  const res = await client.send(queue, 'PING')
  assert.equal(res.body, 'PONG')
})

test('rpc retry (maxAttempts)', async () => {
  const rabbit = autoTeardown(new Connection(RABBITMQ_URL))

  const request = Symbol('request')
  const queue = '__test_f6ad3342820fb0c7'
  const server = autoTeardown(rabbit.createConsumer({queue, queueOptions: {exclusive: true}}, (msg, reply) => {
    server.emit(request, [msg, reply])
  }))
  await expectEvent(server, 'ready')

  const client = autoTeardown(rabbit.createRPCClient({confirm: true, maxAttempts: 2, timeout: 50}))

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
})

test('rpc discard late responses', async () => {
  const rabbit = autoTeardown(new Connection(RABBITMQ_URL))
  const queue = 'f5f8cf8b737f6cdb'
  const server = autoTeardown(createIterableConsumer(rabbit, {
    queue,
    queueOptions: {exclusive: true}
  }))

  const client = autoTeardown(rabbit.createRPCClient({confirm: true, timeout: 50}))

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
})

test('setup should fully complete before publishing', async () => {
  let interrupt: Promise<AsyncMessage>
  // TODO write a proxy util instead of fake server
  const [port, server] = await useFakeServer(async (socket, next) => {
    let req: DataFrame|void

    // Connection negotiation
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionStart,
      params: {
        versionMajor: 0,
        versionMinor: 9,
        serverProperties: {
          capabilities: {},
          cluster_name: '',
        },
        mechanisms: 'PLAIN',
        locales: 'en_US'
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ConnectionStartOK)

    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionTune,
      params: {
        channelMax: 2047,
        frameMax: 131072,
        heartbeat: 60
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ConnectionTuneOK)

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ConnectionOpen)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionOpenOK,
      params: {
        knownHosts: ''
      }
    }))


    // RPC Server setup
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ChannelOpen)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.ChannelOpenOK,
      params: {
        rsvp1: ''
      }
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.QueueDeclare)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.QueueDeclareOK,
      params: {
        queue: String(req.params.queue),
        messageCount: 0,
        consumerCount: 0
      }
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicConsume)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.BasicConsumeOK,
      params: {
        consumerTag: 'server'
      }
    }))


    // RPC Client setup
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ChannelOpen)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.ChannelOpenOK,
      params: {
        rsvp1: ''
      }
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.QueueDeclare)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.QueueDeclareOK,
      params: {
        consumerCount: 0,
        messageCount: 0,
        queue: String(req.params.queue),
      }
    }))

    //// HERE'S THE KICKER ////
    // Client tries to send a request after the channel is established, but
    // before the reply consumer exists
    interrupt = client.send(queue, 'PING')
    ///////////////////////////

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    // BasicPublish should come AFTER BasicConsumeOK
    assert.equal(req.methodId, Cmd.BasicConsume,
      `${Cmd[req.methodId]} != BasicConsume`)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.BasicConsumeOK,
      params: {
        consumerTag: 'client'
      }
    }))


    // RPC Client sends request 1
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicPublish)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 1,
      methodId: Cmd.BasicDeliver,
      params: {
        consumerTag: 'server',
        deliveryTag: 1,
        redelivered: false,
        exchange: String(req.params.exchange),
        routingKey: String(req.params.routingKey)
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.HEADER)
    socket.write(encodeFrame({
      type: FrameType.HEADER,
      channelId: 1,
      bodySize: req.bodySize,
      fields: {
        ...req.fields,
        replyTo: 'amq.rabbitmq.reply-to.xxx'
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.BODY)
    socket.write(encodeFrame({
      type: FrameType.BODY,
      channelId: 1,
      payload: req.payload,
    }))


    // RPC Client sends request 2
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicPublish)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 1,
      methodId: Cmd.BasicDeliver,
      params: {
        consumerTag: 'server',
        deliveryTag: 1,
        redelivered: false,
        exchange: String(req.params.exchange),
        routingKey: String(req.params.routingKey)
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.HEADER)
    socket.write(encodeFrame({
      type: FrameType.HEADER,
      channelId: 1,
      bodySize: req.bodySize,
      fields: {
        ...req.fields,
        replyTo: 'amq.rabbitmq.reply-to.xxx'
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.BODY)
    socket.write(encodeFrame({
      type: FrameType.BODY,
      channelId: 1,
      payload: req.payload,
    }))


    // RPC Server sends response 1
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicPublish)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 2,
      methodId: Cmd.BasicDeliver,
      params: {
        consumerTag: 'client',
        deliveryTag: 1,
        redelivered: false,
        exchange: String(req.params.exchange),
        routingKey: String(req.params.routingKey),
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.HEADER)
    socket.write(encodeFrame({
      type: FrameType.HEADER,
      channelId: 2,
      bodySize: req.bodySize,
      fields: req.fields,
    }))
    req = await next()
    assert.equal(req?.type, FrameType.BODY)
    socket.write(encodeFrame({
      type: FrameType.BODY,
      channelId: 2,
      payload: req.payload,
    }))

    // RPC Server sends response 2
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicPublish)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 2,
      methodId: Cmd.BasicDeliver,
      params: {
        consumerTag: 'client',
        deliveryTag: 2,
        redelivered: false,
        exchange: String(req.params.exchange),
        routingKey: String(req.params.routingKey),
      }
    }))
    req = await next()
    assert.equal(req?.type, FrameType.HEADER)
    socket.write(encodeFrame({
      type: FrameType.HEADER,
      channelId: 2,
      bodySize: req.bodySize,
      fields: req.fields,
    }))
    req = await next()
    assert.equal(req?.type, FrameType.BODY)
    socket.write(encodeFrame({
      type: FrameType.BODY,
      channelId: 2,
      payload: req.payload,
    }))


    // Shutting down
    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.BasicCancel)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.BasicCancelOK,
      params: {
        consumerTag: String(req.params.consumerTag)
      }
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ChannelClose)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.ChannelCloseOK,
      params: void 0
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ChannelClose)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: req.channelId,
      methodId: Cmd.ChannelCloseOK,
      params: void 0
    }))

    req = await next()
    assert.equal(req?.type, FrameType.METHOD)
    assert.equal(req.methodId, Cmd.ConnectionClose)
    socket.write(encodeFrame({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionCloseOK,
      params: void 0
    }))

    socket.end()
    server.close()
  })

  const rabbit = autoTeardown(new Connection({port}))
  const queue = '__test_d84b115f8dba19ab__'
  const client = autoTeardown(rabbit.createRPCClient({
    queues: [{queue, passive: true}]
  }))
  const rpcServer = autoTeardown(rabbit.createConsumer({
    queue: queue,
    noAck: true,
    queueOptions: {exclusive: true}
  }, async (msg, reply) => {
    await reply('PONG')
  }))

  await expectEvent(rpcServer, 'ready')
  const res = await client.send(queue, 'PING') // send another request during setup
  assert.equal(res.body, 'PONG', 'got the response')
})
