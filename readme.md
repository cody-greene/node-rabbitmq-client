Look at `rabbitmq-client.flow.js` for the full API.

Limitations:
- does not support the "nowait" param

Notable Differences from amqplib (squaremo/amqp.node):
- Dooes not support less than node-v10.x
- No dependencies
- Failed connections automatically reconnect
- Built-in clustering/high-availability support
- Uses native Promises inside & out
- Uses named args instead of positional arguments
- ch.basicPublish() returns a Promise when publisher confirms are enabled on the channel
- "x-arguments" like "x-message-ttl" don't have camelCase aliases


## Getting started
```
const Connection = require('rabbitmq-client')
const connection = new Connection('amqp://guest:guest@localhost:5672')
connection.on('error', (err) => {
  // connection refused, etc
  console.error(err.stack)
})

connection.acquire().then(ch => {
  // This does not return a promise by default
  ch.basicPublish('my-queue', {title: 'just some object'})

  // It's your responsibility to close any acquired channels
  return ch.close()
}).then(() => {
  // Graceful shutdown once all channels are closed
  return connection.close()
}).catch(err => {
  console.log(err)
})
```

This library includes helper functions for creating publishers/consumers. These combine a few of the lower level amqp methods and can recover after connection loss. These are much safer to use since they don't provide direct access to a channel, which would end up in the "closed" state after connection loss. Be sure to look at rabbitmq-client.flow.js for the full details.
- Connection#createPublisher()
- Connection#createConsumer()
```
const pro = connection.createPublisher(['my-queue', 'my-other-queue'])

// publish to the new queues
// publisher-confirms are off by default so this returns undefined
pro.publish('my-queue', {title: 'Hello, AMQP!'})
pro.publish('my-other-queue', 'just some text')

// close the channel
pro.close().catch(err => { console.error(err.stack) })



const consumer = connection.createConsumer({
  queue: 'my-queue',
  passive: true, // don't create the channel
  prefetchCount: 1, // consume one at a time
}, async (msg) => {
  console.log(msg)
  await smthingAsync()
})

// keep listening for messages until consumer.close()
```

The basic methods look like this (async-await syntax):
```
const ch = await conection.acquire()
await ch.queueDeclare({
  queue: 'my-queue',
  exclusive: true,
})
// enable publisher confirms manually
await ch.confirmSelect()
await ch.basicPublish('my-queue', {title: 'just some object'})
await ch.close()
```

If you're publishing too quickly for the socket or for the rabbitmq server to keep up then use `connection.unblocked` and `connection.on('drain', cb)` to check for backpressure. This will help you avoid filling up the TCP socket's send-buffer and crashing with an OOM error.
Backpressure example:
```
async function publishOneMillionTimes(connection, queue, data, max=1000000) {
  let ch = await connection.acquire()
  await ch.queueDeclare(queue)
  await new Promise((resolve) => {
    let index = 0
    write()
    function write() {
      console.log('start publishing')
      while (connection.unblocked && index < max) {
        index += 1
        ch.basicPublish(queue, data)
      }
      if (index < max) {
        console.log('pause until drained')
        connection.once('drain', write)
      } else {
        resolve(ch.close())
      }
    }
  })
}
```
