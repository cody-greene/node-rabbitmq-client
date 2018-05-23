'use strict'
const EventEmitter = require('events')

/**
 * Public interface:
 * new Connection(options)
 * new Connection(connectionString)
 * Connection#on('error', fn)
 * Connection#close(done)
 * Connection#acquire() => Promise<Channel>
 * Connection#createConsumer(props, onDeliver) => Promise<Channel>
 * Channel#on('error', fn)
 * Channel#release()
 * Channel#[classMethod](props) => Promise<object>
 *
 * Channels may not be created directly. They must be acquired through a
 * Connection.
 *
 * - pause acquire() while connecting
 * - automatically re-estabish connection
 * - disconnected: acquire() should fail
 * - disconnected: active channels should throw errors for any operation
 * -
 */

/**
 * @emits Channel#error
 */
class Channel extends EventEmitter {
  /**
   * Should only be used internally. Users should look to Connection#acquire()
   */
  constructor() {
    // TODO
  }

  /**
   * Return this object to the resource pool. This library is not responsible
   * for channels released in transaction-mode. i.e. like a rental car,
   * return them in good condition.
   */
  release() {
    // TODO
  }

  /**
   * @param {object} props
   * @return {Promise<object>} responseProps
   */
  // async [class.method](props) {}
}

/**
 * @emits Connection#error
 */
class Connection extends EventEmitter {
  constructor(optionsOrUrl) {
    super()
    // TODO
  }

  /**
   * Get a new AMQP channel from the resource pool. A channel is needed to send
   * commands to the server.
   * @return {Promise<Channel>}
   */
  async acquire() {
    // TODO
  }

  /**
   * Attempt to gracefully close the connection by draining the channel pool
   * @param {func} done Will be invoked when the socket is fully closed
   * @public
   */
  close(done) {
    // TODO
  }

  /**
   * Acquire a channel, declare/assert a queue, apply QOS rules, and finally
   * start listening for messages.
   *
   * @param {object} props Passed to queue.declare, basic.qos, basic.consume
   * @param {func} onDeliver(envelope, channel)
   * queue.declare: queue, passive, durable, exclusive, autoDelete, noWait
   * basic.qos: prefetchSize, prefetchCount, global
   * basic.consume: queue, consumerTag, noLocal, noAck, exclusive, noWait
   */
  async createConsumer(props, onDeliver) {
    let ch = await this.acquire()
    props = Object.assign({
      prefetchCount: 1,
    }, props, {
      noWait: false,
      global: false,
    })
    let {queue} = await ch.queueDeclare(props)

    // queue.declare may generate a random name if the client left it blank
    props.queue = queue

    await ch.basicQos(props)
    await ch.basicConsume(props, onDeliver)
    return ch
  }


  /**
   * Acquire a channel and declare one or more queues.
   *
   * @param {object|object[]} options
   * queue.declare: queue, passive, durable, exclusive, autoDelete, noWait
   */
  async createPublisher(options) {
    let ch = await this.acquire()
    if (Array.isArray(options)) {
      let fns = options.map(opt => ch.queueDeclare.bind(ch, opt))
      await this.opt.Promise.all(fns)
    }
    else {
      await ch.queueDeclare(options)
    }
    return ch
  }
}

module.exports = Connection
