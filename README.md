## RabbitMQ Client

https://github.com/cody-greene/node-rabbitmq-client

Node.js client library for [RabbitMQ](https://www.rabbitmq.com), a "message broker."

- No dependencies
- Failed connections automatically reconnect
- Optional higher-level consumer/publisher objects for even more robustness
- Typescript
- [See here for full API documentation](http://cody-greene.github.io/node-rabbitmq-client) and the generated .d.ts files have tons of comments visible to your IDE
- Uses native Promises
- Uses named args instead of positional arguments
- "x-arguments" like "x-message-ttl" don't have camelCase aliases

## Getting started
```javascript
import Connection from 'rabbitmq-client'

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

  // create a queue for the duration of this connection
  await ch.queueDeclare({queue: 'my-queue', exclusive: true})

  const data = {title: 'just some object'}

  // resolves when the data has been flushed through the socket
  // or if ch.confirmSelect() was called, will wait for an acknowledgement
  await ch.basicPublish({routingKey: 'my-queue'}, data)

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

This library includes helper functions for creating publishers/consumers. These combine a few of the lower level amqp methods and can recover after connection loss. These are much safer to use since they don't provide direct access to a channel, which would end up in the "closed" state after connection loss.

- {@link Connection.createPublisher}
- {@link Connection.createConsumer}

```javascript
const rabbit = new Connection()

const pro = rabbit.createPublisher({
  // call Channel.confirmSelect()
  confirm: true,
  // ensure the existence of an exchange before we use it
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}]
})

// just like Channel.basicPublish()
await pro.publish({exchange: 'my-events', routingKey: 'org.users.create'},
  {id: 1, name: 'Alan Turing'})

// close the underlying channel when we're done, e.g. the application is closing
await pro.close()

const consumer = rabbit.createConsumer({
  queue: 'user-events',
  queueOptions: {exclusive: true},
  // handle 2 messages at a time
  qos: {prefetchCount: 2},
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}],
  queueBindings: [
    // queue should get messages for org.users.create, org.users.update, ...
    {queue: 'user-events', exchange: 'my-events', routingKey: 'org.users.*'}
  ]
}, async (msg) => {
  console.log(msg)
  await doSomething(msg)
  // msg is acknowledged when this function returns
  // or msg is rejected (and maybe requeued) if this function throws an error
})

// if we want to stop our application gracefully then we can stop consuming
// messages and wait for any pending handlers to settle like this:
await consumer.close()
```
