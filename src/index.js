'use strict'
const Connection = require('./connection')
const {AMQPChannelError, AMQPConnectionError, AMQPError} = require('./exception')

const PUBLIC_METHODS = [
  'basicAck',
  'basicCancel',
  'basicConsume',
  'basicGet',
  'basicNack',
  'basicPublish',
  'basicQos',
  'basicRecover',
  'basicReject',
  'confirmSelect',
  'exchangeBind',
  'exchangeDeclare',
  'exchangeDelete',
  'exchangeUnbind',
  'queueBind',
  'queueDeclare',
  'queueDelete',
  'queuePurge',
  'queueUnbind',
  'txCommit',
  'txRollback',
  'txSelect',
]

class RabbitMQChannel {
  constructor(ch) {
    this._ch = ch
  }
  close() {
    return this._ch.close()
  }
  on(evtName, cb) {
    this._ch.on(evtName, cb)
  }
  off(evtName, cb) {
    this._ch.off(evtName, cb)
  }
  get active() {
    return this._ch.active
  }
  get unblocked() {
    return this._ch.active && this._ch.conn.unblocked
  }
}

for (const method of PUBLIC_METHODS) {
  RabbitMQChannel.prototype[method] = function (a, b) {
    return this._ch[method](a, b)
  }
}

class RabbitMQConnection {
  constructor(connectionOptions) {
    this._conn = new Connection(connectionOptions)
  }
  on(evtName, cb) {
    this._conn.on(evtName, cb)
  }
  once(evtName, cb) {
    this._conn.once(evtName, cb)
  }
  off(evtName, cb) {
    this._conn.off(evtName, cb)
  }
  close() {
    return this._conn.close()
  }
  acquire() {
    return this._conn.acquire().then(ch => new RabbitMQChannel(ch))
  }
  get unblocked() {
    return this._conn.unblocked
  }

  createConsumer(props, handler) {
    let ch = null
    if (typeof props === 'string') {
      props = {queue: props, passive: true}
    }
    const establishChannel = async () => {
      if (!ch || !ch.active) {
        ch = await this.acquire()
      }
      await ch.queueDeclare(props)
      await ch.basicQos(props)
      const consumerTag = await ch.basicConsume(props, (envelope) => {
        let dfd = null
        try {
          dfd = handler(envelope)
        } catch (err) {
          dfd = Promise.reject(err)
        }
        Promise.resolve(dfd).then(() => {
          if (!props.noAck) {
            return ch.basicAck({deliveryTag: envelope.deliveryTag})
          }
        }, (err) => {
          // leave it up to the user to capture and log handler errors
          // in their preferred manner
          if (!(err instanceof AMQPChannelError)) {
            return ch.basicReject({deliveryTag: envelope.deliveryTag, requeue: props.requeue})
          }
        }).catch(err => {
          this._conn.emit('error', err)
        })
      })
      const checkCancel = (tag) => {
        // this event is triggered when the queue is deleted
        if (tag === consumerTag) {
          ch.off('basic.cancel', checkCancel)
          wrapper()
        }
      }
      ch.on('basic.cancel', checkCancel)
      this.once('connection', wrapper)
    }
    const wrapper = () => {
      establishChannel().catch(err => {
        this.off('connection', wrapper)
        err.message = 'consumer is dead: ' + err.message
        this._conn.emit('error', err)
      })
    }
    const close = () => {
      this.off('connection', wrapper)
      if (!ch) {
        return Promise.resolve()
      }
      return ch.close()
    }
    wrapper()
    return {close}
  }

  async transaction(fn) {
    const ch = await this.acquire()
    await ch.txSelect()
    try {
      await fn(ch)
    } catch (err) {
      if (!(err instanceof AMQPChannelError)) {
        await ch.txRollback()
        await ch.close()
      }
      throw err
    }
    await ch.txCommit()
    await ch.close()
  }

  createPublisher(props) {
    let ch
    if (typeof props === 'string' || Array.isArray(props)) {
      props = {queues: props}
    } else {
      props = Object.assign({}, props)
    }
    if (typeof props.queues === 'string' || (typeof props.queues == 'object' && !Array.isArray(props.queues))) {
      props.queues = [props.queues]
    }
    const establishChannel = async () => {
      ch = await this.acquire()
      if (props.confirm) {
        await ch.confirmSelect()
      }
      if (props.queues) {
        await Promise.all(props.queues.map(def => ch.queueDeclare(def)))
      }
      if (typeof props.onBasicReturn == 'function') {
        ch.on('basic.return', props.onBasicReturn)
      }
    }
    return {
      publish: async (where, what) => {
        if (!ch || !ch.active) {
          await establishChannel()
        }
        await ch.basicPublish(where, what)
      },
      close: async () => {
        if (ch) {
          await ch.close()
        }
      },
      get unblocked() {
        return ch ? ch.unblocked : false
      }
    }
  }
}

module.exports = Object.assign(RabbitMQConnection, {
  AMQPChannelError,
  AMQPConnectionError,
  AMQPError,
})
