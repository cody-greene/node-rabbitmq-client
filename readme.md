This starts at a high level for a "quick start" kind of guide, with the helper functions for publishing/consuming. Then it will become increasingly specific.



Additional Error codes:
- MAX_CHANNELS no more channels available on the connection
- EDRAIN acquire failed channel pool is draining
- CONN_CLOSE socket closed unexpectedly
- CH_CLOSE channel is closed
- VERSION_MISMATCH server does not support this version of the AMQP protocol
- ETIMEDOUT connection timed out
- NACK message rejected by server


Limitations:
- does not support the "nowait" param

Notable Differences from amqplib (squaremo/amqp.node):
- No dependencies
- Uses native Promises inside & out
- Uses named args instead of positional arguments
- ch.basicPublish() returns a Promise when publisher confirms are enabled on the channel
- Failed connections automatically reconnect
- Built-in clustering/high-availability support
- "x-arguments" like "x-message-ttl" don't have camelCase aliases

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
