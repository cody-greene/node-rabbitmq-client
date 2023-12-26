[![npm version](https://badge.fury.io/js/rabbitmq-client.svg)](https://badge.fury.io/js/rabbitmq-client)

## RabbitMQ Client
Node.js client library for [RabbitMQ](https://www.rabbitmq.com/documentation.html). Publish
messages, declare rules for routing those messages into queues, consume messages from queues.

Why not amqplib?
- No dependencies
- Automatically re-connect, re-subscribe, or retry publishing
- Optional higher-level Consumer/Publisher API for even more robustness
- Written in typescript and published with heavily commented type definitions
- [See here for full API documentation](http://cody-greene.github.io/node-rabbitmq-client)
- Intuitive API with named parameters instead of positional
- "x-arguments" like "x-message-ttl" don't have camelCase aliases

## Performance
Performance is comparable to amqplib (see ./benchmark.ts).

|                        Task Name                  | ops/sec | Average Time (ns) |  Margin  | Samples |
|---------------------------------------------------|---------|-------------------|----------|---------|
| rabbitmq-client publish-confirm (null route)      | 2,611   |  382919           | ±3.69%   |  1306   |
| amqplib publish-confirm (null route)              | 2,315   |  431880           | ±4.89%   |  1158   |
| rabbitmq-client publish-confirm (transient queue) |   961   | 1039884           | ±1.07%   |   481   |
| amqplib publish-confirm (transient queue)         | 1,059   |  943706           | ±1.34%   |   530   |

## Quick start
In addition to the lower-level RabbitMQ methods, this library exposes two main
interfaces, a `Consumer` and a `Publisher` (which should cover 90% of uses
cases), as well as a third `RPCClient` for request-response communication.
```javascript
import {Connection} from 'rabbitmq-client'

// Initialize:
const rabbit = new Connection('amqp://guest:guest@localhost:5672')
rabbit.on('error', (err) => {
  console.log('RabbitMQ connection error', err)
})
rabbit.on('connection', () => {
  console.log('Connection successfully (re)established')
})

// Consume messages from a queue:
// See API docs for all options
const sub = rabbit.createConsumer({
  queue: 'user-events',
  queueOptions: {durable: true},
  // handle 2 messages at a time
  qos: {prefetchCount: 2},
  // Optionally ensure an exchange exists
  exchanges: [{exchange: 'my-events', type: 'topic'}],
  // With a "topic" exchange, messages matching this pattern are routed to the queue
  queueBindings: [{exchange: 'my-events', routingKey: 'users.*'}],
}, async (msg) => {
  console.log('received message (user-events)', msg)
  // The message is automatically acknowledged (BasicAck) when this function ends.
  // If this function throws an error, then msg is rejected (BasicNack) and
  // possibly requeued or sent to a dead-letter exchange. You can also return a
  // status code from this callback to control the ack/nack behavior
  // per-message.
})

sub.on('error', (err) => {
  // Maybe the consumer was cancelled, or the connection was reset before a
  // message could be acknowledged.
  console.log('consumer error (user-events)', err)
})

// Declare a publisher
// See API docs for all options
const pub = rabbit.createPublisher({
  // Enable publish confirmations, similar to consumer acknowledgements
  confirm: true,
  // Enable retries
  maxAttempts: 2,
  // Optionally ensure the existence of an exchange before we use it
  exchanges: [{exchange: 'my-events', type: 'topic'}]
})

// Publish a message to a custom exchange
await pub.send(
  {exchange: 'my-events', routingKey: 'users.visit'}, // metadata
  {id: 1, name: 'Alan Turing'}) // message content

// Or publish directly to a queue
await pub.send('user-events', {id: 1, name: 'Alan Turing'})

// Clean up when you receive a shutdown signal
async function onShutdown() {
  // Waits for pending confirmations and closes the underlying Channel
  await pub.close()
  // Stop consuming. Wait for any pending message handlers to settle.
  await sub.close()
  await rabbit.close()
}
process.on('SIGINT', onShutdown)
process.on('SIGTERM', onShutdown)
```

## Connection.createConsumer() vs Channel.basicConsume()
The above `Consumer` & `Publisher` interfaces are recommended for most cases.
These combine a few of the lower level RabbitMQ methods (exposed on the
`Channel` interface) and and are much safer to use since they can recover after
connection loss, or after a number of other edge-cases you may not have
imagined. Consider the following list of scenarios (not exhaustive):
- Connection lost due to a server restart, missed heartbeats (timeout), forced
  by the management UI, etc.
- Channel closed as a result of publishing to an exchange which does not exist
  (or was deleted), or attempting to acknowledge an invalid deliveryTag
- Consumer closed from the management UI, or because the queue was deleted, or
  because basicCancel() was called

In all of these cases you would need to create a new channel and re-declare any
queues/exchanges/bindings before you can start publishing/consuming messages
again. And you're probably publishing many messages, concurrently, so you'd
want to make sure this setup only runs once per connection. If a consumer is
cancelled then you may be able to reuse the channel but you still need to check
the queue and so on...

The `Consumer` & `Publisher` interfaces abstract all of that away by running
the necessary setup as needed and handling all the edge-cases for you.

## Managing queues & exchanges
A number of management methods are available on the `Connection` interface; you
can create/delete queues, exchanges, or bindings between them. It's generally
safer to do this declaratively with a Consumer or Publisher. But maybe you
just want to do something once.

```javascript
const rabbit = new Connection()

await rabbit.queueDeclare({queue: 'my-queue', exclusive: true})

await rabbit.exchangeDeclare({queue: 'my-queue', exchange: 'my-exchange', type: 'topic'})

await rabbit.queueBind({queue: 'my-queue', exchange: 'my-exchange'})

const {messageCount} = await rabbit.queueDeclare({queue: 'my-queue', passive: true})
```

And if you really want to, you can acquire a raw AMQP Channel but this should
be a last resort.

```javascript
// Will wait for the connection to establish and then create a Channel
const ch = await rabbit.acquire()

// Channels can emit some events too (see documentation)
ch.on('close', () => {
  console.log('channel was closed')
})

const msg = ch.basicGet('my-queue')
console.log(msg)

// It's your responsibility to close any acquired channels
await ch.close()
```

## RPCClient: request-response communication between services
This will create a single "client" `Channel` on which you may publish messages
and listen for direct responses. This can allow, for example, two
micro-services to communicate with each other using RabbitMQ as the middleman
instead of directly via HTTP.

```javascript
// rpc-server.js
const rabbit = new Connection()

const rpcServer = rabbit.createConsumer({
  queue: 'my-rpc-queue'
}, async (req, reply) => {
  console.log('request:', req.body)
  await reply('pong')
})

process.on('SIGINT', async () => {
  await rpcServer.close()
  await rabbit.close()
})
```

```javascript
// rpc-client.js
const rabbit = new Connection()

const rpcClient = rabbit.createRPCClient({confirm: true})

const res = await rpcClient.send('my-rpc-queue', 'ping')
console.log('response:', res.body) // pong

await rpcClient.close()
await rabbit.close()
```
