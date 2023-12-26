import test from 'node:test'
import assert from 'node:assert/strict'
import Connection, {AsyncMessage} from '../src'
import {createServer} from 'node:net'
import {expectEvent, createDeferred, Deferred} from '../src/util'
import {MethodFrame, DataFrame, Cmd, FrameType} from '../src/codec'
import {useFakeServer} from './util'

const RABBITMQ_URL = process.env.RABBITMQ_URL

test('can publish and get messages', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  //rabbit.on('error', (err) => { t.error(err) })

  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})

  const m0 = await ch.basicGet({queue})
  assert.equal(m0, undefined, 'basicGet returns empty when the queue is empty')

  const body = {color: 'green'}
  await ch.basicPublish({routingKey: queue}, body)

  const m1 = await ch.basicGet({queue})
  if (m1 == null) return assert.fail('expected a message but got none')
  assert.equal(m1.contentType, 'application/json')
  assert.deepEqual(m1.body, body)
  ch.basicAck(m1)

  await ch.basicPublish({routingKey: queue}, 'my data')

  const m2 = await ch.basicGet({queue})
  if (m2 == null) return assert.fail('expected a message but got none')
  assert.equal(m2.contentType, 'text/plain')
  assert.equal(m2.body, 'my data')
  ch.basicAck(m2)

  await ch.close()
  await rabbit.close()
})

test('can publish confirmed messages', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()

  await ch.confirmSelect()
  assert.ok(true, 'enabled confirm mode')

  const {queue} = await ch.queueDeclare({exclusive: true})

  await ch.basicPublish({routingKey: queue}, 'my data')
  assert.ok(true, 'published message')

  await ch.close()
  await rabbit.close()
})

test('Connection#close() will gracefully end the connection', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  //rabbit.on('error', (err) => t.error(err))

  await expectEvent(rabbit, 'connection')
  assert.ok(true, 'established connection')
  rabbit.once('connection', () => assert.fail('should not reconnect'))

  await rabbit.close()
  assert.ok(true, 'closed connection')
})

test('Connection#close() should wait for channels to close (after reconnections)', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryLow: 25
  })

  await expectEvent(rabbit, 'connection')
  assert.ok(true, 'established connection')

  rabbit._socket.destroy()
  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'CONN_CLOSE',
    'connection reset')

  await expectEvent(rabbit, 'connection')
  assert.ok(true, 're-established connection')

  const ch = await rabbit.acquire()
  rabbit.close().catch(err => assert.ifError(err))
  await ch.confirmSelect()
  await ch.basicQos({prefetchCount: 1})
  await ch.close()
  await rabbit.close()
})

test('checks for a protocol version mismatch', async () => {
  // create stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return assert.fail('expected server addr obj')
  server.on('connection', (socket) => {
    // server should respond with the expected protocol version and close the connection
    assert.ok(true, 'connection attempt')
    socket.end('AMQP\x00\x00\x00\x00')
    server.close()
  })

  const rabbit = new Connection({port: addr.port, retryLow: 25})

  const err1 = await expectEvent(rabbit, 'error')
  assert.equal(err1.code, 'VERSION_MISMATCH',
    'should get a version error')

  // TODO repeated errors are currently suppressed; maybe that should be a optional flag
  //const err2 = await expectEvent(rabbit, 'error')
  //assert.equal(err2.code, 'VERSION_MISMATCH',
  //  'should attempt reconnect')

  await rabbit.close()
  assert.ok(true, 'closed connection')
})

test('[opt.connectionTimeout] is a time limit on each connection attempt', async () => {
  // create a stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return assert.fail('expected server addr obj')
  server.on('connection', () => {
    // never respond
    server.close()
  })

  const rabbit = new Connection({
    port: addr.port,
    connectionTimeout: 25
  })

  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'CONNECTION_TIMEOUT',
    'should get timeout error')

  await rabbit.close()
})

test('will reconnect when connection.close is received from the server', async () => {
  const [port, server] = await useFakeServer([
    async (socket, next) => {
      let frame

      // S:connection.start
      socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionStartOK)

      // S:connection.tune
      socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionOpen)
      // S:connection.open-ok
      socket.write('AQAAAAAABQAKACkAzg', 'base64')

      // S:connection.close
      socket.end('AQAAAAAAIwAKADIBQBhDT05ORUNUSU9OX0ZPUkNFRCAtIHRlc3QAAAAAzg', 'base64')
      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionCloseOK)
    },
    async (socket, next) => {
      let frame

      // S:connection.start
      socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionStartOK)

      // S:connection.tune
      socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionOpen)
      // S:connection.open-ok
      socket.write('AQAAAAAABQAKACkAzg', 'base64')

      frame = await next() as MethodFrame
      assert.equal(frame.methodId, Cmd.ConnectionClose)
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
  assert.ok(true, 'established connection')

  // can also use this cmd when testing with real server
  // rabbitmqctl close_connection $(rabbitmqctl list_connections pid client_properties | grep -F '__connection.close_test__' | head -n1 | awk '{print $1}') test

  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'CONNECTION_FORCED',
    'connection lost')

  await expectEvent(rabbit, 'connection')
  assert.ok(true, 'reconnected')

  await rabbit.close()
})

test('handles channel errors', async () => {
  const queue = '__test_e8f4f1d045bc0097__' // this random queue should not exist
  const rabbit = new Connection(RABBITMQ_URL)

  const ch = await rabbit.acquire()
  assert.ok(true, 'got channel')
  const err = await ch.queueDeclare({passive: true, queue}).catch(err => err)
  assert.equal(err.code, 'NOT_FOUND',
    'caught channel error')
  assert.equal(ch.active, false,
    'channel is closed')

  await rabbit.close()
})

test('publish with confirms are rejected with channel error', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.confirmSelect()
  const pending = [
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__'}, ''),
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__', exchange: '__not_found_9a1e1bba7f62571d__'}, ''),
    ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__'}, ''),
  ]
  const [r0, r1, r2] = await Promise.allSettled(pending)

  assert.equal(r0.status, 'fulfilled', '1st publish ok')
  // should be rejected because the exchange does not exist
  if (r1.status === 'rejected')
    assert.equal(r1.reason.code, 'NOT_FOUND', '2nd publish rejected')
  else assert.fail('2nd publish should fail')
  // remaining unconfirmed publishes should just get CH_CLOSE
  if (r2.status === 'rejected')
    assert.equal(r2.reason.code, 'CH_CLOSE', '3rd publish rejected')
  else assert.fail('3rd publish should fail')
  assert.equal(ch.active, false, 'channel is dead')

  await ch.close()
  await rabbit.close()
})

test('publish without confirms should emit channel errors on the Connection', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.basicPublish({routingKey: '__not_found_9a1e1bba7f62571d__', exchange: '__not_found_9a1e1bba7f62571d__'}, '')
  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'NOT_FOUND', 'emitted error')
  await rabbit.close()
})

test('basic.ack can emit channel errors', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  ch.basicAck({deliveryTag: 1}) // does not return a Promise
  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'PRECONDITION_FAILED', 'unknown delivery tag')
  await rabbit.close()
})

test('basic.ack can emit codec errors', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  // @ts-ignore intentional error
  ch.basicAck({deliveryTag: 'not a number'}) // does not return a Promise
  const err = await expectEvent(rabbit, 'error')
  assert.ok(err instanceof SyntaxError, 'got encoding error')
  await rabbit.close()
})

test('handles encoder errors', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()

  const err = await ch.basicCancel({consumerTag: null as any}).catch(err => err)
  assert.equal(err.message, 'consumerTag is undefined; expected a string',
    'should check required params before encoding')

  // will explode when encoding
  const bomb: string = {toString() { throw new TypeError('boom') }} as any

  assert.equal(ch.id, 1, 'got a channel')
  const errs = await Promise.all([
    ch.basicCancel({consumerTag: bomb}).catch(err => err), // the bad one
    ch.queueDeclare({exclusive: true}).catch(err => err), // this will never be sent
    expectEvent(ch, 'close'),
  ])
  assert.equal(errs[0].message, 'boom')
  assert.equal(errs[1].code, 'CH_CLOSE', 'buffered RPC is rejected')

  const other = await rabbit.acquire()
  assert.equal(other.id, ch.id,
    'created a new channel with the same id (old channel was properly closed)')

  await other.close()
  await rabbit.close()
})

test('handles encoder errors (while closing)', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()

  // will explode when encoding
  const bomb: string = {toString() { throw new TypeError('boom') }} as any

  assert.equal(ch.id, 1, 'got a channel')
  const errs = await Promise.all([
    ch.basicCancel({consumerTag: bomb}).catch(err => err), // the bad one
    ch.queueDeclare({exclusive: true}).catch(err => err), // this will never be sent
    ch.close(), // <-- new
    expectEvent(ch, 'close'),
  ])
  assert.equal(errs[0].message, 'boom')
  assert.equal(errs[1].code, 'CH_CLOSE', 'buffered RPC is rejected')

  const other = await rabbit.acquire()
  assert.equal(other.id, ch.id,
    'created a new channel with the same id (old channel was properly closed)')

  await other.close()
  await rabbit.close()
})

test('[opt.heartbeat] creates a timeout to detect a dead socket', async () => {
  let s1complete = false

  const [port, server] = await useFakeServer(async (socket, next) => {
    server.close()
    let frame

    // S:connection.start
    socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionStartOK)

    // S:connection.tune
    socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionOpen)
    // S:connection.open-ok
    socket.write('AQAAAAAABQAKACkAzg', 'base64')

    // don't send hearbeats; wait for timeout
    s1complete = true
  })

  const rabbit = new Connection({
    port: port,
    heartbeat: 1
  })

  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'SOCKET_TIMEOUT',
    'got socket timeout error')

  await rabbit.close()
  assert.equal(s1complete, true)
})

test('[opt.heartbeat] regularly sends a heartbeat frame on its own', async () => {
  let s1complete = false

  const [port, server] = await useFakeServer(async (socket, next) => {
    server.close()
    let frame

    // S:connection.start
    socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionStartOK)

    // S:connection.tune
    socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionOpen)
    // S:connection.open-ok
    socket.write('AQAAAAAABQAKACkAzg', 'base64')

    frame = await next() as DataFrame
    assert.equal(frame.type, FrameType.HEARTBEAT, 'got heartbeat from client')

    // S:connection.close
    socket.end('AQAAAAAAIwAKADIBQBhDT05ORUNUSU9OX0ZPUkNFRCAtIHRlc3QAAAAAzg', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionCloseOK, 'client confirmed forced close')
    s1complete = true
  })

  const rabbit = new Connection({
    port: port,
    heartbeat: 1
  })

  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'CONNECTION_FORCED')

  await rabbit.close()
  assert.equal(s1complete, true)
})

test('can create a basic consumer', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})

  const expectedMessages: Deferred<AsyncMessage>[] = [createDeferred(), createDeferred()]
  await ch.basicPublish({routingKey: queue}, 'red data')
  await ch.basicPublish({routingKey: queue}, 'black data')
  assert.ok(true, 'published messages')

  const {consumerTag} = await ch.basicConsume({queue}, (msg) => {
    expectedMessages[msg.deliveryTag - 1].resolve(msg)
  })
  assert.ok(true, 'created basic consumer')

  const [m1, m2] = await Promise.all(expectedMessages.map(dfd => dfd.promise))
  assert.equal(m1.body, 'red data')
  assert.equal(m2.body, 'black data')

  await ch.basicCancel({consumerTag})
  assert.ok(true, 'cancelled consumer')

  await ch.close()
  await rabbit.close()
})

test('emits basic.return with rejected messages', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  await ch.basicPublish({
    routingKey: '__basic.return test__',
    mandatory: true
  }, 'my data')
  const msg = await expectEvent(ch, 'basic.return')
  assert.equal(msg.body, 'my data',
    'msg returned')
  assert.equal(msg.replyText, 'NO_ROUTE',
    'msg is unroutable')

  await ch.close()
  await rabbit.close()
})

test('handles zero-length returned messages', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const payload = Buffer.alloc(0)
  await ch.basicPublish({mandatory: true, routingKey: '__not_found_7953ec8de0da686e__'}, payload)
  const msg = await expectEvent(ch, 'basic.return')
  assert.equal(msg.replyText, 'NO_ROUTE', 'message returned')
  assert.equal(msg.body.byteLength, 0, 'body is empty')

  await ch.close()
  await rabbit.close()
})

test('[opt.maxChannels] can cause acquire() to fail', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    maxChannels: 1
  })

  const [r0, r1] = await Promise.allSettled([
    rabbit.acquire(),
    rabbit.acquire()
  ])

  assert.equal(r0.status, 'fulfilled', 'ch 1 acquired')
  r0.value.close()
  assert.equal(r1.status, 'rejected', 'ch 2 unavailable')
  await rabbit.close()
})

test('Connection#acquire() can time out', async () => {
  // create a stub server
  const server = createServer()
  server.listen()
  await expectEvent(server, 'listening')
  const addr = server.address()
  if (addr == null || typeof addr == 'string')
    return assert.fail('expected server addr obj')
  server.on('connection', () => {
    // never respond
    server.close()
  })

  const rabbit = new Connection({port: addr.port, acquireTimeout: 25})

  try {
    await rabbit.acquire()
    assert.fail('expected acquire() to fail')
  } catch (err) {
    assert.equal(err.code, 'TIMEOUT',
      'got timeout error')
  }

  await rabbit.close()
})

test('Connection#createPublisher()', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_c77466a747761f46__'

  const pro = rabbit.createPublisher({
    confirm: true,
    queues: [{queue, exclusive: true}],
  })
  assert.ok(true, 'created publisher')

  // should emit 'basic.return' events
  await pro.publish({routingKey: '__not_found_7315197c1ab0e5f6__', mandatory: true},
    'my returned message')
  assert.ok(true, 'publish acknowledged')
  const msg0 = await expectEvent(pro, 'basic.return')
  assert.equal(msg0.body, 'my returned message',
    'got returned message')

  // should establish queues, bindings
  await pro.publish({routingKey: queue},
    'my good message')
  assert.ok(true, 'publish acknowledged')
  const ch = await rabbit.acquire()
  const msg1 = await ch.basicGet({queue})
  await ch.close()
  assert.equal(msg1?.body, 'my good message',
    'got published message from temporary queue')

  // should recover after channel error
  let err0
  try {
    await pro.publish({exchange: '__not_found_7315197c1ab0e5f6__'}, '')
  } catch (err) {
    err0 = err
  }
  assert.equal(err0?.code, 'NOT_FOUND',
    'caused a channel error')
  await pro.publish({routingKey: queue}, '')
  assert.ok(true, 'published on new channel')

  // should recover after connection loss
  rabbit._socket.destroy()
  await expectEvent(rabbit, 'error')
  assert.ok(true, 'connection reset')
  await pro.publish({routingKey: queue}, '')
  assert.ok(true, 'published after connection error')

  // should not publish after close()
  await pro.close()
  let err1
  try {
    await pro.publish({routingKey: queue}, '')
  } catch (err) {
    err1 = err
  }
  assert.equal(err1.code, 'CLOSED',
    'failed to publish after close()')

  await rabbit.close()
})

test('Connection#createPublisher() concurrent publishes should trigger one setup', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const pro = rabbit.createPublisher()

  await Promise.all([
    pro.publish({routingKey: '__not_found_7953ec8de0da686e__'}, ''),
    pro.publish({routingKey: '__not_found_7953ec8de0da686e__'}, '')
  ])

  assert.equal(rabbit._state.leased.size, 1,
    'one channel created')

  await pro.close()
  await rabbit.close()
})

test('Publisher should retry failed setup', async () => {
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

  assert.equal(res.status, 'rejected', 'setup failed 1st time')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true}) // auto-delete after test

  await pro.publish({routingKey: queue}, 'hello')
  assert.ok(true, 'setup completed and message published')

  await pro.close()
  await ch.close()
  await rabbit.close()
})

test('Publisher (maxAttempts) should retry failed publish', async () => {
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
 assert.equal(err.code, 'NOT_FOUND', 'got retry event')
  assert.ok(true, 'publish succeeded eventually')
  await ch.close()
  await pro.close()
  await rabbit.close()
})

test('Connection should retry with next cluster node', async () => {
  let s1complete = false
  let s2complete = false

  const [port1, server1] = await useFakeServer(async (socket, next) => {
    server1.close()
    let frame

    // S:connection.start
    socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionStartOK)

    // S:connection.tune
    socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionOpen)
    // S:connection.open-ok
    socket.write('AQAAAAAABQAKACkAzg', 'base64')

    // S:connection.close
    socket.end('AQAAAAAAIwAKADIBQBhDT05ORUNUSU9OX0ZPUkNFRCAtIHRlc3QAAAAAzg', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionCloseOK, 'client confirmed forced close')
    s1complete = true
  })
  const [port2, server2] = await useFakeServer(async (socket, next) => {
    server2.close()
    let frame

    assert.ok(true, 'connected to 2nd host')

    // S:connection.start
    socket.write('AQAAAAAAHAAKAAoACQAAAAAAAAAFUExBSU4AAAAFZW5fVVPO', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionStartOK)

    // S:connection.tune
    socket.write('AQAAAAAADAAKAB4H/wACAAAAPM4', 'base64')
    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionTuneOK)

    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionOpen)
    // S:connection.open-ok
    socket.write('AQAAAAAABQAKACkAzg', 'base64')

    frame = await next() as MethodFrame
    assert.equal(frame.methodId, Cmd.ConnectionClose, 'client initiated close')
    // S:connection.close-ok
    socket.end('AQAAAAAABAAKADPO', 'base64')
    s2complete = true
  })

  const rabbit = new Connection({
    retryLow: 25, // fast reconnect
    hosts: [`localhost:${port1}`, `localhost:${port2}`]
  })

  await expectEvent(rabbit, 'connection')
  assert.ok(true, 'established first connection')
  const err = await expectEvent(rabbit, 'error')
  assert.equal(err.code, 'CONNECTION_FORCED', '1st conn errored')

  await expectEvent(rabbit, 'connection')

  await rabbit.close()
  assert.equal(s1complete, true,
    'server 1 assertions complete')
  assert.equal(s2complete, true,
    'server 2 assertions complete')
})

test('should encode/decode array values in message headers', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const {queue} = await ch.queueDeclare({exclusive: true})
  assert.ok(queue, 'created temporary queue')
  await ch.basicPublish({routingKey: queue, headers: {'x-test-arr': ['red', 'blue']}}, '')
  assert.ok(true, 'publish successful')
  const msg = await ch.basicGet({queue})
  assert.ok(msg, 'recieved message')
  const arr = msg?.headers?.['x-test-arr']
  assert.equal(arr.join(), 'red,blue', 'got the array')
  await ch.close()
  await rabbit.close()
})

test('handles (un)auth error', async () => {
  const wrongurl = new URL(RABBITMQ_URL || 'amqp://guest:guest@localhost:5672')
  wrongurl.password = 'badpassword'
  const rabbit = new Connection(wrongurl.toString())
  const err = await expectEvent(rabbit, 'error')
 assert.equal(err.code, 'ACCESS_REFUSED')
  await rabbit.close()
})

test('out-of-order RPC', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const ch = await rabbit.acquire()
  const queues = ['1a9370fa04be7108', '5be264772fdd703b']

  await Promise.all([
    ch.queueDeclare({queue: queues[0], exclusive: true}),
    ch.basicConsume({queue: queues[0], consumerTag: 'red'}, () => {}),
    ch.queueDeclare({queue: queues[1], exclusive: true}),
  ])

  // rabbit will emit an UNEXPECTED_FRAME err if a response arrives out of order

  await ch.close()
  await rabbit.close()
})

test('lazy channel', async () => {
  const rabbit = new Connection(RABBITMQ_URL)

  // 'can manage queues without explicitly creating a channel'
  const {queue} = await rabbit.queueDeclare({exclusive: true})

  // 'lazy channel can recover from errors'
  const [res] = await Promise.allSettled([
    rabbit.queueDeclare({queue: '6b5a171726e573d5', passive: true})
  ])
  assert.equal(res.status === 'rejected' && res.reason.code, 'NOT_FOUND')
  await rabbit.queueDeclare({queue, passive: true})

  // 'lazy channel auto-closes'
  await rabbit.close()
})

// TODO opt.frameMax
// TODO codec
