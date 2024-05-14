import test from 'node:test'
import assert from 'node:assert/strict'
import Connection, {AsyncMessage, ConsumerStatus} from '../src'
import {PREFETCH_EVENT} from '../src/Consumer'
import {expectEvent, createDeferred, Deferred, READY_STATE} from '../src/util'
import {sleep, createIterableConsumer} from './util'

type TMParams = [Deferred<void>, AsyncMessage]

const RABBITMQ_URL = process.env.RABBITMQ_URL

test('Consumer#close() waits for setup to complete', async () => {
  const rabbit = new Connection({url: RABBITMQ_URL, retryLow: 25})
  const queue = '__test_b1d57ae9eb91df85__'

  const consumer = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true},
  }, async () => {

  })

  // wait for setup to actually start
  await sleep(1)

  await Promise.all([
    expectEvent(consumer, 'ready'),
    consumer.close(),
  ])
  assert.ok(true, 'got "ready" event while closing')

  await rabbit.close()
})

test('Connection#createConsumer()', async () => {
  const rabbit = new Connection({url: RABBITMQ_URL, retryLow: 25})

  const queue = '__test_df1865ed59a6b6272b14206b85863099__'
  const exchange = '__test_6d074e50d427e75a__'

  //const dfd = createDeferred<void>()
  const consumer = createIterableConsumer(rabbit, {
    requeue: true,
    queue: queue,
    queueOptions: {exclusive: true},
    exchanges: [{autoDelete: true, exchange, type: 'topic'}],
    queueBindings: [{queue, exchange, routingKey: 'audit.*'}]
  })

  await expectEvent(consumer, 'ready')
  assert.ok(true, 'consumer is ready')

  const ch = await rabbit.acquire()

  // ack nack
  await ch.basicPublish({exchange, routingKey: 'audit.test'}, 'red fish')
  const msg = await consumer.read()
  assert.equal(msg.body, 'red fish', 'got the message')
  assert.equal(msg.redelivered, false, '1st delivery of this msg')
  msg.reject(new Error('forced basic.nack'))
  const err0 = await expectEvent(consumer, 'error')
  assert.equal(err0.message, 'forced basic.nack',
    'emitted error from failed handler')
  const msg2 = await consumer.read()
  assert.equal(msg2.redelivered, true,
    'basic.ack for redelivered msg')
  msg2.resolve()

  // can recover after queue deleted (basic.cancel)
  consumer.once('error', err => { assert.equal(err.code, 'CANCEL_FORCED', 'consumer cancelled') })
  const {messageCount} = await ch.queueDelete({queue})
  assert.equal(messageCount, 0, 'queue is empty')
  await expectEvent(consumer, 'ready')
  assert.ok(true, 'consumer is ready again')
  await ch.close()

  // can recover after connection loss
  rabbit._socket.destroy()
  await expectEvent(rabbit, 'error')
  assert.ok(true, 'connection reset')
  await expectEvent(consumer, 'ready')
  assert.ok(true, 'consumer is ready yet again')

  // can recover after channel error (channel.close)
  const [res] = await Promise.allSettled([
    consumer._ch?.queueDeclare({passive: true, queue: '__should_not_exist_7c8367661d62d8cc__'})
  ])
  assert.equal(res.status, 'rejected')
  assert.equal(res.reason.code, 'NOT_FOUND', 'caused a channel error')
  await expectEvent(consumer, 'ready')
  assert.ok(true, 'consumer is ready for the last time')

  await consumer.close()
  await rabbit.close()
})

test('Consumer does not create duplicates when setup temporarily fails', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryHigh: 25
  })
  const queue = '__test1524e4b733696e9c__'
  const consumer = rabbit.createConsumer({
    queue: queue,
    // setup will fail until queue is created
    queueOptions: {passive: true}
  }, () => { /* do nothing */ })

  const err = await expectEvent(consumer, 'error')
  assert.equal(err.code, 'NOT_FOUND', 'setup should fail at first')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true}) // auto-deleted
  await expectEvent(consumer, 'ready')
  assert.ok(true, 'consumer setup successful')
  consumer.once('ready', () => {
    assert.fail('expected only ONE ready event')
  })

  await ch.close()
  await consumer.close()
  await rabbit.close()
})

test('Consumer waits for in-progress jobs to complete before reconnecting', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryLow: 1, retryHigh: 1
  })
  const queue = '__test1c23944c0f14a28f__'
  const consumer = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true},
    qos: {prefetchCount: 1}
  }, (msg) => {
    const dfd = createDeferred()
    consumer.emit('test.message', [dfd, msg])
    // complete the job at some later time with dfd.resolve()
    return dfd.promise
  })

  await expectEvent(consumer, 'ready')
  const ch = await rabbit.acquire()
  await ch.basicPublish(queue, 'red')
  const [job1, msg1] = await expectEvent(consumer, 'test.message')
  assert.equal(msg1.body, 'red', 'consumed a message')

  // intentionally cause a channel error so setup has to rerun
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  assert.ok(true, 'channel killed')

  await sleep(25)
  job1.resolve()
  const err = await expectEvent(consumer, 'error')
  assert.equal(err.code, 'CH_CLOSE', 'old channel is closed')
  const [job2, msg2] = await expectEvent(consumer, 'test.message')
  job2.resolve()
  assert.equal(msg2.body, 'red')
  assert.equal(msg2.redelivered, true, 'consumed redelivered message after delay')

  await consumer.close()
  await ch.close()
  await rabbit.close()
})

test('Consumer should limit handler concurrency', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryHigh: 25,
  })
  const queue = '__test1c23944c0f14a28f__'
  const consumer = rabbit.createConsumer({
    queue: queue,
    queueOptions: {exclusive: true},
    concurrency: 1,
  }, (msg) => {
    const dfd = createDeferred()
    consumer.emit('test.message', [dfd, msg])
    // complete the job at some later time with dfd.resolve()
    return dfd.promise
  })

  type TMParams = [Deferred<void>, AsyncMessage]

  await expectEvent(consumer, 'ready')
  const ch = await rabbit.acquire()
  await Promise.all([
    ch.basicPublish(queue, 'red'),
    ch.basicPublish(queue, 'blue'),
    ch.basicPublish(queue, 'green'),
  ])
  const [job1, msg1] = await expectEvent<TMParams>(consumer, 'test.message')
  await expectEvent(consumer, PREFETCH_EVENT)
  await expectEvent(consumer, PREFETCH_EVENT)
  assert.equal(msg1.body, 'red', 'consumed a message')
  assert.equal(msg1.redelivered, false, 'redelivered=false')
  assert.equal(consumer._prefetched.length, 2, '2nd message got buffered')
  job1.resolve()

  const [job2a, msg2a] = await expectEvent<TMParams>(consumer, 'test.message')
  assert.equal(msg2a.body, 'blue', 'consumed 2nd message')
  assert.equal(msg2a.redelivered, false, 'redelivered=false')
  assert.equal(consumer._prefetched.length, 1, '3rd message still buffered')

  // intentionally cause a channel error so setup has to rerun
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  assert.equal(consumer._prefetched.length, 0, 'buffered message was dropped')

  job2a.resolve()
  const err = await expectEvent(consumer, 'error')
  assert.equal(err.code, 'CH_CLOSE', 'old channel is closed')

  // messages should be redelivered after channel error

  const [job2b, msg2b] = await expectEvent<TMParams>(consumer, 'test.message')
  assert.equal(msg2b.body, 'blue', 'consumed 2nd message again')
  assert.equal(msg2b.redelivered, true, 'redelivered=true')
  job2b.resolve()

  const [job3, msg3] = await expectEvent<TMParams>(consumer, 'test.message')
  assert.equal(msg3.body, 'green', 'consumed 3rd message')
  assert.equal(msg3.redelivered, true, 'redelivered=true')
  job3.resolve()

  await consumer.close()
  await ch.close()
  await rabbit.close()
})

test('Consumer concurrency with noAck=true', async () => {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    retryHigh: 25,
  })
  const queue = '__test1c23944c0f14a28f__'
  const consumer = rabbit.createConsumer({
    queue: queue,
    noAck: true,
    queueOptions: {exclusive: true},
    concurrency: 1,
  }, (msg) => {
    const dfd = createDeferred()
    consumer.emit('test.message', [dfd, msg])
    // complete the job at some later time with dfd.resolve()
    return dfd.promise
  })

  await expectEvent(consumer, 'ready')
  const ch = await rabbit.acquire()

  await Promise.all([
    ch.basicPublish(queue, 'red'),
    ch.basicPublish(queue, 'blue'),
  ])

  const [job1, msg1] = await expectEvent<TMParams>(consumer, 'test.message')
  assert.equal(msg1.body, 'red', 'consumed 1st message')
  await expectEvent(consumer, PREFETCH_EVENT)
  assert.equal(consumer._prefetched.length, 1, '2nd message got buffered')

  // intentionally cause a channel error
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  assert.equal(consumer._prefetched.length, 1, 'buffered message remains')

  // with noAck=true, close() should wait for remaining messages to process
  const consumerClosed = consumer.close()

  // should not emit an error after the channel reset
  job1.resolve()

  const [job2, msg2] = await expectEvent<TMParams>(consumer, 'test.message')
  assert.equal(msg2.body, 'blue', 'consumed 2nd message')
  assert.equal(msg2.redelivered, false, 'redelivered=false')

  job2.resolve()

  await consumerClosed
  await ch.close()
  await rabbit.close()
})

test('Consumer return codes', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const queue = '__test_03f0726440598228'
  const deadqueue = '__test_fadb49f36193d615'
  const exchange = '__test_db6d7203284a44c2'
  const sub = createIterableConsumer(rabbit, {
    queue,
    requeue: false,
    queueOptions: {
      exclusive: true,
      arguments: {'x-dead-letter-exchange': exchange}
    },
  })
  const dead = createIterableConsumer(rabbit, {
    queue: deadqueue,
    queueOptions: {exclusive: true},
    queueBindings: [{exchange, routingKey: queue}],
    exchanges: [{exchange, type: 'fanout', autoDelete: true}]
  })

  await expectEvent(sub, 'ready')
  await expectEvent(dead, 'ready')
  const ch = await rabbit.acquire()

  // can drop by default
  await ch.basicPublish(queue, 'red')
  const msg1 = await sub.read()
  assert.equal(msg1.redelivered, false)
  msg1.reject(new Error('expected'))
  const err = await expectEvent(sub, 'error')
  assert.equal(err.message, 'expected')
  const msg2 = await dead.read()
  assert.equal(msg2.body, 'red', 'got dead-letter')
  msg2.resolve()

  // can selectively requeue
  await ch.basicPublish(queue, 'blue')
  const msg3 = await sub.read()
  assert.equal(msg3.redelivered, false)
  msg3.resolve(ConsumerStatus.REQUEUE)
  const msg4 = await sub.read()
  assert.equal(msg4.redelivered, true, 'msg redelivered')

  // can explicitly drop
  msg4.resolve(ConsumerStatus.DROP)
  const msg5 = await dead.read()
  assert.equal(msg5.body, 'blue', 'message dropped')
  msg5.resolve()

  await ch.close()
  await sub.close()
  await dead.close()
  await rabbit.close()
})

test('Consumer stats', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const pub = rabbit.createPublisher({confirm: true})
  const sub = createIterableConsumer(rabbit, {
    queueOptions: {exclusive: true}
  })

  await expectEvent(sub, 'ready')

  await Promise.all([
    pub.send(sub.queue, null),
    pub.send(sub.queue, null),
  ])

  const msg1 = await sub.read()
  msg1.resolve(ConsumerStatus.ACK)

  const msg2 = await sub.read()
  msg2.resolve(ConsumerStatus.REQUEUE)

  const msg3 = await sub.read()
  msg3.resolve(ConsumerStatus.DROP)

  await Promise.all([
    pub.close(),
    sub.close(),
    rabbit.close(),
  ])

  assert.equal(sub.stats.acknowledged, 1)
  assert.equal(sub.stats.requeued, 1)
  assert.equal(sub.stats.dropped, 1)
})

test('Lazy consumer', async () => {
  const rabbit = new Connection(RABBITMQ_URL)
  const sub = createIterableConsumer(rabbit, {
    queueOptions: {exclusive: true},
    lazy: true
  })

  assert.equal(sub._readyState, READY_STATE.CLOSED)

  sub.start()
  await expectEvent(sub, 'ready')

  assert.equal(sub._readyState, READY_STATE.OPEN)

  await sub.close()
  assert.equal(sub._readyState, READY_STATE.CLOSED)

  // Should allow restarting after close
  sub.start()
  await expectEvent(sub, 'ready')
  assert.equal(sub._readyState, READY_STATE.OPEN)

  await Promise.all([
    sub.close(),
    rabbit.close(),
  ])

  assert.equal(sub._readyState, READY_STATE.CLOSED)
})
