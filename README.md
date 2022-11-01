## RabbitMQ Client

https://github.com/cody-greene/node-rabbitmq-client

Node.js client library for [RabbitMQ](https://www.rabbitmq.com), a "message broker."

Why not amqplib?
- No dependencies
- Failed connections automatically reconnect
- Optional higher-level consumer/publisher objects for even more robustness
- Written in typescript and published with heavily commented type definitions
- [See here for full API documentation](http://cody-greene.github.io/node-rabbitmq-client)
- Uses native Promises
- Intuitive API with named parameters instead of positional
- "x-arguments" like "x-message-ttl" don't have camelCase aliases

## Performance
Performance is comparable to amqplib. See ./benchmark.ts for time to publish X messages in batches of Y:
module          | total msg | batch sz | mean    | min | max | SD     | total time
----------------|-----------|----------|---------|-----|-----|--------|-----------
rabbitmq-client | 10000     | 500      | 115     | 32  | 231 | 60.272 | 2289ms
amqplib         | 10000     | 500      | 124.25  | 24  | 240 | 62.302 | 2476ms
rabbitmq-client | 10000     | 50       | 112.255 | 8   | 391 | 82.903 | 22350ms
amqplib         | 10000     | 50       | 142.66  | 7   | 519 | 96.098 | 28428ms

## Getting started
```javascript
import Connection from 'rabbitmq-client'

// See API docs for all options
const rabbit = new Connection({
  url: 'amqp://guest:guest@localhost:5672',
  // wait 1 to 30 seconds between connection retries
  retryLow: 1000,
  retryHigh: 30000,
})

rabbit.on('error', (err) => {
  // connection refused, etc
  console.error(err)
})

rabbit.on('connection', () => {
  console.log('The connection is successfully (re)established')
})

async function run() {
  // will wait for the connection to establish before creating a Channel
  const ch = await rabbit.acquire()

  // channels can emit some events too
  ch.on('close', () => {
    console.log('channel was closed')
  })

  // create a queue for the duration of this connection
  await ch.queueDeclare({queue: 'my-queue', exclusive: true})

  const data = {title: 'just some object'}

  // resolves when the data has been flushed through the socket
  // or if ch.confirmSelect() was called, will wait for an acknowledgement
  await ch.basicPublish({routingKey: 'my-queue'}, data)

  // consume messages until cancelled or until the channel is closed
  await ch.basicConsume({queue: 'my-queue'}, (msg) => {
    console.log(msg)
    // acknowledge receipt of the message
    ch.basicAck({deliveryTag: msg.deliveryTag})
  })

  // It's your responsibility to close any acquired channels
  await ch.close()

  // Don't forget to end the connection
  await rabbit.close()
}

run()
```

This library includes helper functions for creating publishers/consumers. These combine a few of the lower level amqp methods and can recover after connection loss, or after a number of other edge-cases you may not have considered. These are much safer to use since they don't provide direct access to a channel.

Consider the following list of scenarios (not exhaustive):
- Connection lost due to a server restart, missed heartbeats (timeout), forced by the management UI, etc.
- Channel closed as a result of publishing to an exchange which does not exist (or was deleted), or attempting to acknowledge an invalid deliveryTag
- Consumer closed from the management UI, or because the queue was deleted, or because basicCancel() was called

In all of these cases you would need to create a new channel and re-declare any queues/exchanges/bindings before you can start publishing/consuming messages again. And you're probably publishing many messages, concurrently, so you'd want to make sure this setup only runs once per connection. If a consumer is cancelled then you may be able to reuse the channel but you still need to check the queue and ...

The following methods aim to abstract all of that away by running the necessary setup as needed and handling all the edge-cases for you.

- {@link Connection.createPublisher | Connection.createPublisher(config)}
- {@link Connection.createConsumer | Connection.createConsumer(config, cb)}
- {@link Connection.createRPCClient | Connection.createRPCClient(config)}

```javascript
const rabbit = new Connection()

// See API docs for all options
const pro = rabbit.createPublisher({
  // enable acknowledgements (resolve with error if publish is unsuccessful)
  confirm: true,
  // enable retries
  maxAttempts: 2,
  // ensure the existence of an exchange before we use it otherwise we could
  // get a NOT_FOUND error
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}]
})

// just like Channel.basicPublish()
await pro.publish(
  {exchange: 'my-events', routingKey: 'org.users.create'},
  {id: 1, name: 'Alan Turing'})

// close the underlying channel when we're done,
// e.g. the application is closing
await pro.close()

// See API docs for all options
const consumer = rabbit.createConsumer({
  queue: 'user-events',
  queueOptions: {exclusive: true},
  // handle 2 messages at a time
  qos: {prefetchCount: 2},
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}],
  queueBindings: [
    // queue should get messages for org.users.create, org.users.update, ...
    {exchange: 'my-events', routingKey: 'org.users.*'}
  ]
}, async (msg) => {
  console.log(msg)
  await doSomething(msg)
  // msg is automatically acknowledged when this function resolves or msg is
  // rejected (and maybe requeued, or sent to a dead-letter-exchange) if this
  // function throws an error
})

// maybe the consumer was cancelled, or a message wasn't acknowledged
consumer.on('error', (err) => {
  console.log('consumer error', err)
})

// if we want to stop our application gracefully then we can stop consuming
// messages and wait for any pending handlers to settle like this:
await consumer.close()
```
