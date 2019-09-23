'use strict'
const test = require('../tape-promise')
const RMQConnection = require('../src/')
const AMQP_URL = process.env.AMQP_URL
const URL = require('url').URL

let refs = null

if (!AMQP_URL) {
  throw new Error('AMQP_URL is undefined')
}

async function setup(assert) {
  await teardown()
  refs = []
  assert.timeoutAfter(5000)
  const conn = new RMQConnection(AMQP_URL)
  conn.on('error', assert.end)
  refs.push(conn)
  return conn
}

async function teardown() {
  if (refs != null) {
    await Promise.all(refs.map(ref => ref.close()))
    refs = null
  }
}

test.onFinish(teardown)

// 'exclusive' queues may only be accessed by the current connection,
// and are deleted when that connection closes.
test('declare queue, publish, receive message', async (assert) => {
  const amqp = await setup(assert)
  const ch = await amqp.acquire()
  assert.pass('got a channel')
  refs.push(ch)
  const {queue, messageCount} = await ch.queueDeclare({exclusive: true})
  assert.equal(messageCount, 0, 'new queue is empty')
  assert.ok(queue, 'got a random queue name')
  const m1 = await ch.basicGet({queue})
  assert.equal(m1, null, 'basicGet returns null on a empty queue')
  await ch.basicPublish(queue, 'Hello world.')
  await ch.basicPublish(queue, {data: 'cats'})
  const m2 = await ch.basicGet({queue})
  assert.equal(m2.body, 'Hello world.', 'got text body')
  const m3 = await ch.basicGet({queue})
  assert.deepEqual(m3.body, {data: 'cats'}, 'got json body')
})

test('connection.transaction', async (assert) => {
  const amqp = await setup(assert)
  const ch1 = await amqp.acquire()
  refs.push(ch1)
  const {queue, messageCount} = await ch1.queueDeclare({exclusive: true})
  assert.equal(messageCount, 0, 'new queue is empty')

  await assert.rejects(() => {
    return amqp.transaction(async (ch) => {
      await ch.basicPublish(queue, 'test msg 1')
      throw new Error('fake error')
    })
  }, /fake error/, 'txn should fail')
  const msg1 = await ch1.basicGet({queue, noAck: true})
  assert.equal(msg1, null, 'queue should still be empty')

  await amqp.transaction(async (ch) => {
    await ch.basicPublish(queue, 'test msg 2')
  })
  const msg2 = await ch1.basicGet({queue, noAck: true})
  assert.equal(msg2.body, 'test msg 2', 'can publish msg in txn')
})

test('connection.createConsumer', async (assert) => {
  assert.plan(5)
  const amqp = await setup(assert)
  const ch = await amqp.acquire()
  refs.push(ch)
  const {queue, messageCount} = await ch.queueDeclare({exclusive: true})
  assert.equal(messageCount, 0, 'new queue is empty')
  await ch.basicPublish(queue, 'msg 1')
  let first = true
  const consumer = await amqp.createConsumer(queue, async (msg) => {
    assert.equal(msg.body, 'msg 1', 'consuming correct message')
    if (first) {
      first = false
      assert.pass('consumed 1st time (reject)')
      throw new Error('reject the message')
    } else {
      assert.pass('consumed 2nd time (ack)')
      assert.end()
    }
  })
  refs.push(consumer)
})

test('connection.createPublisher (basic.return)', async (assert) => {
  assert.plan(3)
  const expectedMessageBody = 'abc 1'
  const amqp = await setup(assert)
  const pub = amqp.createPublisher({
    onBasicReturn: (msg) => {
      assert.equal(msg.body, expectedMessageBody, 'message returned')
      assert.end()
    }
  })
  assert.pass('created Publisher')
  refs.push(pub)
  pub.publish({routingKey: '', mandatory: true}, expectedMessageBody)
  assert.pass('published unroutable mandatory msg')
})

test('confirm-mode channel', async (assert) => {
  const connection = await setup(assert)
  const ch = await connection.acquire()
  refs.push(ch)
  const {queue} = await ch.queueDeclare({exclusive: true})
  await ch.confirmSelect()
  const pr = ch.basicPublish(queue, 'confirmed msg body')
  await pr
  assert.ok(pr != null && typeof pr.then === 'function',
    'basicPublish returned a Promise')
})

test('cluster failover', async (assert) => {
  assert.plan(3)
  await teardown()
  refs = []
  assert.timeoutAfter(5000)
  const url = new URL(AMQP_URL)
  const fakeHost = 'localhost:12345'
  const realHost = url.hostname + ':' + url.port
  const conn = new RMQConnection({
    url: AMQP_URL,
    // should fail once, then connect to the second host
    hosts: [fakeHost, realHost],
    username: url.username,
    password: url.password,
  })
  assert.pass('created connection with multiple hosts')
  refs.push(conn)
  conn.once('error', (err) => {
    assert.ok(err, 'got first connection error')
    conn.on('error', assert.end)
  })
  conn.on('connection', () => {
    assert.pass('"connected" event trigged')
    assert.end()
  })
})

// TODO connection reconnect
// TODO consumer reconnect
// TODO publisher reconnect
