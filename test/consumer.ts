import test from 'tape'
import Connection from '../src'
import {createDeferred, Deferred} from '../src/util'
import {expectEvent, sleep} from './util'

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
  const err = await expectEvent(consumer, 'error') //
  t.is(err.code, 'CH_CLOSE', 'old channel is closed')
  const [job2, msg2] = await expectEvent(consumer, 'test.message')
  job2.resolve()
  t.is(msg2.body, 'red')
  t.is(msg2.redelivered, true, 'consumed redelivered message after delay')

  await consumer.close()
  await ch.close()
  await rabbit.close()
})
