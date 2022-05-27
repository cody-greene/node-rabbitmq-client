import test from 'tape'
import Connection, {AsyncMessage} from '../src'
import {createServer} from 'net'
import {createDeferred, Deferred} from '../src/util'
import {MethodFrame} from '../src/types'
import {useFakeServer, expectEvent, sleep} from './util'
import {randomBytes} from 'crypto'

const RABBITMQ_URL = process.env.RABBITMQ_URL

test.onFailure(() => process.exit())

test('can publish and get messages', async (t) => {
  t.plan(5)
  const rabbit = new Connection(RABBITMQ_URL)
  //rabbit.on('error', (err) => { t.error(err) })

  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})

  const m0 = await ch.basicGet({queue})
  t.is(m0, undefined, 'basicGet returns empty when the queue is empty')

  const body = {color: 'green'}
  await ch.basicPublish({routingKey: queue}, body)

  const m1 = await ch.basicGet({queue})
  if (m1 == null) return t.fail('expected a message but got none')
  t.is(m1.contentType, 'application/json')
  t.deepEqual(m1.body, body)
  ch.basicAck(m1)

  await ch.basicPublish({routingKey: queue}, 'my data')

  const m2 = await ch.basicGet({queue})
  if (m2 == null) return t.fail('expected a message but got none')
  t.is(m2.contentType, 'text/plain')
  t.is(m2.body, 'my data')
  ch.basicAck(m2)

  await ch.close()
  await rabbit.close()
})

test('can publish confirmed messages', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()

  await ch.confirmSelect()
  t.pass('enabled confirm mode')

  const {queue} = await ch.queueDeclare({exclusive: true})

  // TODO how can I test rejected messages?
  await ch.basicPublish({routingKey: queue}, 'my data')
  t.pass('published message')

  await ch.close()
  await rabbit.close()
})

test('Connection#close() will gracefully end the connection', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  //rabbit.on('error', (err) => t.error(err))

  await expectEvent(rabbit, 'connection')
  t.pass('established connection')
  rabbit.once('connection', () => t.fail('should not reconnect'))

  await rabbit.close()
  t.pass('closed connection')
})

test('Connection#close() should wait for channels to close (after reconnections)', async (t) => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryLow: 25
  })

  await expectEvent(rabbit, 'connection')
  t.pass('established connection')

  rabbit._socket.destroy()
  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'CONN_CLOSE',
    'connection reset')

  await expectEvent(rabbit, 'connection')
  t.pass('re-established connection')

  const ch = await rabbit.acquire()
  rabbit.close().catch(err => t.error(err))
  await ch.confirmSelect()
  await ch.basicQos({prefetchCount: 1})
  await ch.close()
  await rabbit.close()
})

test('checks for a protocol version mismatch', async (t) => {
  t.plan(3)
  // create stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return t.fail('expected server addr obj')
  server.on('connection', (socket) => {
    // server should respond with the expected protocol version and close the connection
    t.pass('connection attempt')
    socket.end('AMQP\x00\x00\x00\x00')
    server.close()
  })

  const rabbit = new Connection({port: addr.port, retryLow: 25})

  const err1 = await expectEvent(rabbit, 'error')
  t.is(err1.code, 'VERSION_MISMATCH',
    'should get a version error')

  // TODO repeated errors are currently suppressed; maybe that should be a optional flag
  //const err2 = await expectEvent(rabbit, 'error')
  //t.equal(err2.code, 'VERSION_MISMATCH',
  //  'should attempt reconnect')

  await rabbit.close()
  t.pass('closed connection')
})

test('[opt.connectionTimeout] is a time limit on each connection attempt', async (t) => {
  // create a stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return t.fail('expected server addr obj')
  server.on('connection', () => {
    // never respond
    server.close()
  })

  const rabbit = new Connection({
    port: addr.port,
    connectionTimeout: 25
  })

  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'CONNECTION_TIMEOUT',
    'should get timeout error')

  await rabbit.close()
})

test('will reconnect when connection.close is received from the server', async (t) => {
  const [port, server] = await useFakeServer([
    async (socket, next) => {
      let frame

      // S:connection.start
      socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.start-ok')

      // S:connection.tune
      socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.tune-ok')

      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.open')
      // S:connection.open-ok
      socket.write('AQAAAAAABQAKACkAzg', 'base64')

      // S:connection.close
      socket.end('AQAAAAAAIwAKADIBQBhDT05ORUNUSU9OX0ZPUkNFRCAtIHRlc3QAAAAAzg', 'base64')
      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.close-ok')
    },
    async (socket, next) => {
      let frame

      // S:connection.start
      socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.start-ok')

      // S:connection.tune
      socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.tune-ok')

      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.open')
      // S:connection.open-ok
      socket.write('AQAAAAAABQAKACkAzg', 'base64')

      frame = await next() as MethodFrame
      t.is(frame.fullName, 'connection.close')
      // S:connection.close-ok
      socket.end('AQAAAAAABAAKADPO', 'base64')
      server.close()
    }
  ])

  const rabbit = new Connection({
    //url: RABBITMQ_URL,
    port: port,
    retryLow: 25, // fast reconnect
    connectionName: '__connection.close_test__'
  })

  await expectEvent(rabbit, 'connection')
  t.pass('established connection')

  // can also use this cmd when testing with real server
  // rabbitmqctl close_connection $(rabbitmqctl list_connections pid client_properties | grep -F '__connection.close_test__' | head -n1 | awk '{print $1}') test

  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'CONNECTION_FORCED',
    'connection lost')

  await expectEvent(rabbit, 'connection')
  t.pass('reconnected')

  await rabbit.close()
})

test('handles channel errors', async (t) => {
  t.plan(3)
  const queue = '__test_e8f4f1d045bc0097__' // this random queue should not exist
  const rabbit = new Connection(RABBITMQ_URL)

  const ch = await rabbit.acquire()
  t.pass('got channel')
  try {
    await ch.queueDeclare({passive: true, queue})
  } catch (err) {
    t.is(err.code, 'NOT_FOUND',
      'caught channel error')
    t.is(ch.active, false,
      'channel is closed')
  }

  await rabbit.close()
})

test('publish with confirms are rejected with channel error', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.confirmSelect()
  const pending = [
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__'}, ''),
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__', exchange: '__not_found_9a1e1bba7f62571d__'}, ''),
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__'}, ''),
  ]
  const [r0, r1, r2] = await Promise.allSettled(pending)

  t.is(r0.status, 'fulfilled', '1st publish ok')
  // should be rejected because the exchange does not exist
  if (r1.status === 'rejected')
    t.is(r1.reason.code, 'NOT_FOUND', '2nd publish rejected')
  else t.fail('2nd publish should fail')
  // remaining unconfirmed publishes should just get CH_CLOSE
  if (r2.status === 'rejected')
    t.is(r2.reason.code, 'CH_CLOSE', '3rd publish rejected')
  else t.fail('3rd publish should fail')
  t.is(ch.active, false, 'channel is dead')

  await ch.close()
  await rabbit.close()
})

test('publish without confirms should emit channel errors on the Connection', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__', exchange: '__not_found_9a1e1bba7f62571d__'}, '')
  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'NOT_FOUND', 'emitted error')
  await rabbit.close()
})

test('basic.ack can emit channel errors', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  ch.basicAck({deliveryTag: 1}) // does not return a Promise
  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'PRECONDITION_FAILED', 'unknown delivery tag')
  await rabbit.close()
})

test('basic.ack can emit codec errors', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  // @ts-ignore intentional error
  ch.basicAck({deliveryTag: 'not a number'}) // does not return a Promise
  const err = await expectEvent(rabbit, 'error')
  t.assert(err instanceof SyntaxError, 'got encoding error')
  await rabbit.close()
})

test('handles encoder errors', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()

  t.is(ch.id, 1, 'got a channel')
  const emptyParams: any = {}
  const err = await ch.basicCancel(emptyParams).catch(err => err)
  t.is(err.message, 'basic.cancel consumerTag (a required param) is undefined')

  await expectEvent(ch, 'close')
  const other = await rabbit.acquire()
  t.is(other.id, ch.id,
    'created a new channel with the same id (old channel was properly closed)')

  await other.close()
  await rabbit.close()
})

test('[opt.heartbeat] creates a timeout to detect a dead socket', async (t) => {
  t.plan(4)

  const [port, server] = await useFakeServer(async (socket, next) => {
    server.close()
    let frame

    // S:connection.start
    socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
    frame = await next() as MethodFrame
    t.is(frame.fullName, 'connection.start-ok')

    // S:connection.tune
    socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
    frame = await next() as MethodFrame
    t.is(frame.fullName, 'connection.tune-ok')

    frame = await next() as MethodFrame
    t.is(frame.fullName, 'connection.open')
    // S:connection.open-ok
    socket.write('AQAAAAAABQAKACkAzg', 'base64')

    // don't send hearbeats; wait for timeout
  })

  const rabbit = new Connection({
    port: port,
    heartbeat: 1
  })

  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'SOCKET_TIMEOUT',
    'got socket timeout error')

  await rabbit.close()
})

test('can create a basic consumer', async (t) => {
  t.plan(5)
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})

  const expectedMessages: Deferred<AsyncMessage>[] = [createDeferred(), createDeferred()]
  await ch.basicPublish({routingKey: queue}, 'red data')
  await ch.basicPublish({routingKey: queue}, 'black data')
  t.pass('published messages')

  const {consumerTag} = await ch.basicConsume({queue}, (msg) => {
    expectedMessages[Number(msg.deliveryTag) - 1].resolve(msg)
  })
  t.pass('created basic consumer')

  const [m1, m2] = await Promise.all(expectedMessages.map(dfd => dfd.promise))
  t.is(m1.body, 'red data')
  t.is(m2.body, 'black data')

  await ch.basicCancel({consumerTag})
  t.pass('cancelled consumer')

  await ch.close()
  await rabbit.close()
})

test('emits basic.return with rejected messages', async (t) => {
  t.plan(2)
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.basicPublish({
    routingKey: '__basic.return test__',
    mandatory: true
  }, 'my data')
  const msg = await expectEvent(ch, 'basic.return')
  t.is(msg.body, 'my data',
    'msg returned')
  t.is(msg.replyText, 'NO_ROUTE',
    'msg is unroutable')

  await ch.close()
  await rabbit.close()
})

test('handles zero-length returned messages', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const payload = Buffer.alloc(0)
  await ch.basicPublish({mandatory: true, routingKey: '__not_found_7953ec8de0da686e__'}, payload)
  const msg = await expectEvent(ch, 'basic.return')
  t.is(msg.replyText, 'NO_ROUTE', 'message returned')
  t.is(msg.body.byteLength, 0, 'body is empty')

  await ch.close()
  await rabbit.close()
})

test('[opt.maxChannels] can cause acquire() to fail', async (t) => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    maxChannels: 1
  })

  const [r0, r1] = await Promise.allSettled([
    rabbit.acquire(),
    rabbit.acquire()
  ])

  t.is(r0.status, 'fulfilled', 'ch 1 acquired')
  t.is(r1.status, 'rejected', 'ch 2 unavailable')

  if (r0.status === 'fulfilled') await r0.value.close()
  if (r1.status === 'fulfilled') await r1.value.close()
  await rabbit.close()
})

test('Connection#acquire() can time out', async (t) => {
  // create a stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return t.fail('expected server addr obj')
  server.on('connection', () => {
    // never respond
    server.close()
  })

  const rabbit = new Connection({port: addr.port, acquireTimeout: 25})

  try {
    await rabbit.acquire()
    t.fail('expected acquire() to fail')
  } catch (err) {
    t.is(err.code, 'TIMEOUT',
      'got timeout error')
  }

  await rabbit.close()
})

test('Consumer#close() waits for setup to complete', async (t) => {
  const rabbit = new Connection({url: RABBITMQ_URL, retryLow: 25})
  const queue = '__test_b1d57ae9eb91df85__'

  const consumer = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true},
  }, async () => {

  })

  await Promise.all([
    expectEvent(consumer, 'ready'),
    consumer.close(),
  ])
  t.pass('got "ready" event while closing')

  await rabbit.close()
})

test('Connection#createConsumer()', async (t) => {
  t.plan(14)
  const rabbit = new Connection({url: RABBITMQ_URL, retryLow: 25})

  const queue = '__test_df1865ed59a6b6272b14206b85863099__'
  const exchange = '__test_6d074e50d427e75a__'

  const dfd = createDeferred<void>()
  const consumer = rabbit.createConsumer({
    requeue: true,
    queue: queue,
    queueOptions: {exclusive: true},
    exchanges: [{autoDelete: true, exchange, type: 'topic'}],
    queueBindings: [{queue, exchange, routingKey: 'audit.*'}]
  }, async (msg) => {
    t.is(msg.body, 'red fish', 'got the message') // expected 2x
    // should auto nack
    if (!msg.redelivered) throw new Error('forced basic.nack')
    // should auto ack
    t.is(msg.redelivered, true, 'basic.ack for redelivered msg')
    dfd.resolve()
  })

  await expectEvent(consumer, 'ready')
  t.pass('consumer is ready')

  const ch = await rabbit.acquire()
  await ch.basicPublish({exchange, routingKey: 'audit.test'}, 'red fish')
  t.pass('published msg')

  const err0 = await expectEvent(consumer, 'error')
  t.is(err0.message, 'forced basic.nack',
    'emitted error from failed handler')

  await dfd.promise // wait for expected message deliveries
  t.pass('consumer handlers finished')

  // can recover after queue deleted (basic.cancel)
  consumer.once('error', err => { t.is(err.code, 'CANCEL_FORCED', 'consumer cancelled') })
  const {messageCount} = await ch.queueDelete({queue})
  t.is(messageCount, 0, 'queue is empty')
  await expectEvent(consumer, 'ready')
  t.pass('consumer is ready again')
  await ch.close()

  // can recover after connection loss
  rabbit._socket.destroy()
  await expectEvent(rabbit, 'error')
  t.pass('connection reset')
  await expectEvent(consumer, 'ready')
  t.pass('consumer is ready yet again')

  // can recover after channel error (channel.close)
  try {
    await consumer._ch?.queueDeclare({passive: true, queue: '__should_not_exist_7c8367661d62d8cc__'})
  } catch (err) {
    t.equal(err.code, 'NOT_FOUND', 'caused a channel error')
  }
  await expectEvent(consumer, 'ready')
  t.pass('consumer is ready for the last time')

  await consumer.close()
  await rabbit.close()
})

test('Connection#createPublisher()', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_c77466a747761f46__'

  const pro = rabbit.createPublisher({
    confirm: true,
    queues: [{queue, exclusive: true}],
  })
  t.pass('created publisher')

  // should emit 'basic.return' events
  await pro.publish({routingKey: '__not_found_7315197c1ab0e5f6__', mandatory: true},
    'my returned message')
  t.pass('publish acknowledged')
  const msg0 = await expectEvent(pro, 'basic.return')
  t.is(msg0.body, 'my returned message',
    'got returned message')

  // should establish queues, bindings
  await pro.publish({routingKey: queue},
    'my good message')
  t.pass('publish acknowledged')
  const ch = await rabbit.acquire()
  const msg1 = await ch.basicGet({queue})
  await ch.close()
  t.is(msg1?.body, 'my good message',
    'got published message from temporary queue')

  // should recover after channel error
  let err0
  try {
    await pro.publish({exchange: '__not_found_7315197c1ab0e5f6__'}, '')
  } catch (err) {
    err0 = err
  }
  t.is(err0?.code, 'NOT_FOUND',
    'caused a channel error')
  await pro.publish({queue}, '')
  t.pass('published on new channel')

  // should recover after connection loss
  rabbit._socket.destroy()
  await expectEvent(rabbit, 'error')
  t.pass('connection reset')
  await pro.publish({queue}, '')
  t.pass('published after connection error')

  // should not publish after close()
  await pro.close()
  let err1
  try {
    await pro.publish({queue}, '')
  } catch (err) {
    err1 = err
  }
  t.is(err1.code, 'CLOSED',
    'failed to publish after close()')

  await rabbit.close()
})

test('Connection#createPublisher() concurrent publishes should trigger one setup', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const pro = rabbit.createPublisher()

  await Promise.all([
    pro.publish({routingKey: '__not_found_7953ec8de0da686e__'}, ''),
    pro.publish({routingKey: '__not_found_7953ec8de0da686e__'}, '')
  ])

  t.is(rabbit._state.leased.size, 1,
    'one channel created')

  await pro.close()
  await rabbit.close()
})

// TODO opt.frameMax
// TODO frame errors / unexpected channel
// TODO codec
// TODO cluster failover
