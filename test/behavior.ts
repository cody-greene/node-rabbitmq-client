import test from 'tape'
import Connection, {AsyncMessage} from '../src'
import {createServer} from 'node:net'
import {expectEvent, createDeferred, Deferred} from '../src/util'
import {MethodFrame} from '../src/types'
import {useFakeServer, sleep} from './util'

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
  await pro.publish({routingKey: queue}, '')
  t.pass('published on new channel')

  // should recover after connection loss
  rabbit._socket.destroy()
  await expectEvent(rabbit, 'error')
  t.pass('connection reset')
  await pro.publish({routingKey: queue}, '')
  t.pass('published after connection error')

  // should not publish after close()
  await pro.close()
  let err1
  try {
    await pro.publish({routingKey: queue}, '')
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

test('Publisher should retry failed setup', async (t) => {
  const queue = '__not_found_7953ec8de0da686e__'
  const rabbit = new Connection(RABBITMQ_URL)
  const pro = rabbit.createPublisher({
    confirm: true,
    // setup should fail when the queue does not exist
    queues: [{passive: true, queue}]
  })

  const [res] = await Promise.allSettled([
    pro.publish({routingKey: queue}, 'hello')
  ])

  t.is(res.status, 'rejected', 'setup failed 1st time')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true}) // auto-delete after test

  await pro.publish({routingKey: queue}, 'hello')
  t.pass('setup completed and message published')

  await pro.close()
  await ch.close()
  await rabbit.close()
})

test('Publisher (maxAttempts) should retry failed publish', async (t) => {
  const exchange = '__test_ce7cea6070c084fe'
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const pro = rabbit.createPublisher({
    confirm: true,
    maxAttempts: 2,
    exchanges: [{exchange}]
  })
  // establish the internal Channel and exchange (lazy setup)
  await pro.publish({exchange}, 'test1')
  // deleting the exchange should cause the next publish to fail
  await ch.exchangeDelete({exchange})

  const [err] = await Promise.all([
    expectEvent(pro, 'retry'),
    pro.publish({exchange}, 'test2')
  ])
  t.equal(err.code, 'NOT_FOUND', 'got retry event')
  t.pass('publish succeeded eventually')
  await ch.close()
  await pro.close()
  await rabbit.close()
})

test('Connection should retry with next cluster node', async (t) => {
  t.plan(11)

  const [port1, server1] = await useFakeServer(async (socket, next) => {
    server1.close()
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
    t.is(frame.fullName, 'connection.close-ok', 'client confirmed forced close')
  })
  const [port2, server2] = await useFakeServer(async (socket, next) => {
    server2.close()
    let frame

    t.pass('connected to 2nd host')

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
    t.is(frame.fullName, 'connection.close', 'client initiated close')
    // S:connection.close-ok
    socket.end('AQAAAAAABAAKADPO', 'base64')
  })

  const rabbit = new Connection({
    retryLow: 25, // fast reconnect
    hosts: [`localhost:${port1}`, `localhost:${port2}`]
  })

  await expectEvent(rabbit, 'connection')
  t.pass('established first connection')
  const err = await expectEvent(rabbit, 'error')
  t.is(err.code, 'CONNECTION_FORCED', '1st conn errored')

  await expectEvent(rabbit, 'connection')

  await rabbit.close()
})

test('should encode/decode array values in message headers', async (t) => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})
  t.ok(queue, 'created temporary queue')
  await ch.basicPublish({routingKey: queue, headers: {'x-test-arr': ['red', 'blue']}}, '')
  t.pass('publish successful')
  const msg = await ch.basicGet({queue})
  t.ok(msg, 'recieved message')
  const arr = msg?.headers?.['x-test-arr']
  t.is(arr.join(), 'red,blue', 'got the array')
  await ch.close()
  await rabbit.close()
})

test('handles (un)auth error', async (t) => {
  const wrongurl = new URL(RABBITMQ_URL || 'amqp://guest:guest@localhost:5672')
  wrongurl.password = 'badpassword'
  const rabbit = new Connection(wrongurl.toString())
  const err = await expectEvent(rabbit, 'error')
  t.equal(err.code, 'ACCESS_REFUSED')
  await rabbit.close()
})

// TODO opt.frameMax
// TODO frame errors / unexpected channel
// TODO codec
