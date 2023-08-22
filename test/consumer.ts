import test from 'tape'
import Connection, {AsyncMessage, ConsumerStatus} from '../src'
import {PREFETCH_EVENT} from '../src/Consumer'
import {expectEvent, createDeferred, Deferred} from '../src/util'
import {sleep, createIterableConsumer} from './util'

type TMParams = [Deferred<void>, AsyncMessage]

const RABBITMQ_URL = process.env.RABBITMQ_URL

test.onFailure(() => process.exit())

test('Consumer#close() waits for setup to complete', async (t) => {
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

test('Consumer does not create duplicates when setup temporarily fails', async (t) => {
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
  t.is(err.code, 'NOT_FOUND', 'setup should fail at first')

  const ch = await rabbit.acquire()
  await ch.queueDeclare({queue, exclusive: true}) // auto-deleted
  await expectEvent(consumer, 'ready')
  t.pass('consumer setup successful')
  consumer.once('ready', () => {
    t.fail('expected only ONE ready event')
  })

  await ch.close()
  await consumer.close()
  await rabbit.close()
})

test('Consumer waits for in-progress jobs to complete before reconnecting', async (t) => {
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
  t.is(msg1.body, 'red', 'consumed a message')

  // intentionally cause a channel error so setup has to rerun
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  t.pass('channel killed')

  await sleep(25)
  job1.resolve()
  const err = await expectEvent(consumer, 'error')
  t.is(err.code, 'CH_CLOSE', 'old channel is closed')
  const [job2, msg2] = await expectEvent(consumer, 'test.message')
  job2.resolve()
  t.is(msg2.body, 'red')
  t.is(msg2.redelivered, true, 'consumed redelivered message after delay')

  await consumer.close()
  await ch.close()
  await rabbit.close()
})

test('Consumer should limit handler concurrency', async (t) => {
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
  t.is(msg1.body, 'red', 'consumed a message')
  t.is(msg1.redelivered, false, 'redelivered=false')
  t.is(consumer._prefetched.length, 2, '2nd message got buffered')
  job1.resolve()

  const [job2a, msg2a] = await expectEvent<TMParams>(consumer, 'test.message')
  t.is(msg2a.body, 'blue', 'consumed 2nd message')
  t.is(msg2a.redelivered, false, 'redelivered=false')
  t.is(consumer._prefetched.length, 1, '3rd message still buffered')

  // intentionally cause a channel error so setup has to rerun
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  t.is(consumer._prefetched.length, 0, 'buffered message was dropped')

  job2a.resolve()
  const err = await expectEvent(consumer, 'error')
  t.is(err.code, 'CH_CLOSE', 'old channel is closed')

  // messages should be redelivered after channel error

  const [job2b, msg2b] = await expectEvent<TMParams>(consumer, 'test.message')
  t.is(msg2b.body, 'blue', 'consumed 2nd message again')
  t.is(msg2b.redelivered, true, 'redelivered=true')
  job2b.resolve()

  const [job3, msg3] = await expectEvent<TMParams>(consumer, 'test.message')
  t.is(msg3.body, 'green', 'consumed 3rd message')
  t.is(msg3.redelivered, true, 'redelivered=true')
  job3.resolve()

  await consumer.close()
  await ch.close()
  await rabbit.close()
})

test('Consumer concurrency with noAck=true', async (t) => {
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
  t.is(msg1.body, 'red', 'consumed 1st message')
  await expectEvent(consumer, PREFETCH_EVENT)
  t.is(consumer._prefetched.length, 1, '2nd message got buffered')

  // intentionally cause a channel error
  await consumer._ch!.basicAck({deliveryTag: 404})
  await expectEvent(rabbit, 'error')
  t.is(consumer._prefetched.length, 1, 'buffered message remains')

  // with noAck=true, close() should wait for remaining messages to process
  const consumerClosed = consumer.close()

  // should not emit an error after the channel reset
  job1.resolve()

  const [job2, msg2] = await expectEvent<TMParams>(consumer, 'test.message')
  t.is(msg2.body, 'blue', 'consumed 2nd message')
  t.is(msg2.redelivered, false, 'redelivered=false')

  job2.resolve()

  await consumerClosed
  await ch.close()
  await rabbit.close()
})

test('Consumer return codes', async (t) => {
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
  t.equal(msg1.redelivered, false)
  msg1.reject(new Error('expected'))
  const err = await expectEvent(sub, 'error')
  t.equal(err.message, 'expected')
  const msg2 = await dead.read()
  t.equal(msg2.body, 'red', 'got dead-letter')
  msg2.resolve()

  // can selectively requeue
  await ch.basicPublish(queue, 'blue')
  const msg3 = await sub.read()
  t.equal(msg3.redelivered, false)
  msg3.resolve(ConsumerStatus.REQUEUE)
  const msg4 = await sub.read()
  t.equal(msg4.redelivered, true, 'msg redelivered')

  // can explicitly drop
  msg4.resolve(ConsumerStatus.DROP)
  const msg5 = await dead.read()
  t.equal(msg5.body, 'blue', 'message dropped')
  msg5.resolve()

  await ch.close()
  await sub.close()
  await dead.close()
  await rabbit.close()
})

test('Consumer stats', async (t) => {
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

  t.equal(sub.stats.acknowledged, 1)
  t.equal(sub.stats.requeued, 1)
  t.equal(sub.stats.dropped, 1)
})
