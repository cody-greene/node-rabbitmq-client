'use strict'

const Deque = require('./deque')
const {AMQPError, AMQPChannelError} = require('./exception')
const {createDeferred, camelCase} = require('./util')
const {syncMethods, asyncMethods} = require('./spec')

const CH_MODE = {
  NORMAL: 0,
  TRANSACTION: 1,
  CONFIRM: 2,
}

// Channel events: basic.cancel, basic.return
class Channel {
  constructor(id, conn) {
    this.conn = conn
    this.id = id
    this.callbacks = new Map()
    this.frameMax = conn.opt.frameMax
    this.awaitingContent = null
    this.consumers = null
    this.incoming = null
    this.deliveryCount = 1
    this.mode = CH_MODE.NORMAL
    this.uncomfirmed = null
    this.active = true
  }

  on(eventName, fn) {
    this.conn.on(`${this.id}:${eventName}`, fn)
  }
  once(eventName, fn) {
    this.conn.once(`${this.id}:${eventName}`, fn)
  }
  off(eventName, fn) {
    if (fn) {
      this.conn.removeListener(`${this.id}:${eventName}`, fn)
    }
    else {
      this.conn.removeAllListeners(`${this.id}:${eventName}`)
    }
  }
  emit(eventName, params) {
    this.conn.emit(`${this.id}:${eventName}`, params)
  }

  async close() {
    if (!this.active) {
      return
    }
    try {
      if (this.consumers) {
        let tags = Array.from(this.consumers.keys())
        let pending = tags.map(consumerTag => this.basicCancel({consumerTag}))
        await Promise.all(pending)
      }
    } finally {
      this.off('basic.return')
      this.off('basic.cancel')
      await this.conn.channels.destroy(this)
    }
  }

  /**
   * Save a handler (run-once) for an AMQP synchronous method response
   */
  addReplyListener(classMethod) {
    return new Promise((resolve, reject) => {
      let dequeOrDfd = this.callbacks.get(classMethod)
      if (dequeOrDfd == null) {
        this.callbacks.set(classMethod, {resolve, reject})
      }
      else if (dequeOrDfd instanceof Deque) {
        dequeOrDfd.pushRight({resolve, reject})
      }
      else {
        this.callbacks.set(classMethod, new Deque([dequeOrDfd, {resolve, reject}]))
      }
    })
  }
  removeReplyListener(classMethod, dfd) {
    let dequeOrDfd = this.callbacks.get(classMethod)
    if (dequeOrDfd == null) {
      // do nothing
    }
    else if (dequeOrDfd instanceof Deque) {
      dequeOrDfd.remove(dfd)
    }
    else {
      this.callbacks.delete(classMethod)
    }
  }
  callReplyListener(classMethod, params) {
    let dequeOrDfd = this.callbacks.get(classMethod)
    if (dequeOrDfd instanceof Deque) {
      dequeOrDfd.popLeft().resolve(params)
      if (dequeOrDfd.size < 1) {
        this.callbacks.delete(classMethod)
      }
    }
    else if (dequeOrDfd != null) {
      this.callbacks.delete(classMethod)
      dequeOrDfd.resolve(params)
    }
    else {
      // console.error(`unexpected incoming method ${this.id}:${classMethod}`, params)
    }
  }

  /**
   * Invoke a pending response handler
   * e.g. 'channel.open' -> 'channel.open-ok'
   */
  trigger(classMethod, params) {
    // if (this.incoming != null) {
    //   console.error('unexpected method frame, already awaiting header/body')
    // }
    if (['basic.deliver', 'basic.return', 'basic.get-ok'].indexOf(classMethod) !== -1) {
      this.incoming = {classMethod, envelope: params}
    }
    else if (classMethod === 'basic.get-empty') {
      this.callReplyListener('basic.get-ok', null)
    }
    else if (this.mode === CH_MODE.CONFIRM && classMethod === 'basic.ack') {
      this.unconfirmed.get(params.deliveryTag).resolve()
      this.unconfirmed.delete(params.deliveryTag)
    }
    else if (this.mode === CH_MODE.CONFIRM && classMethod === 'basic.nack') {
      this.unconfirmed.get(params.deliveryTag).reject(new AMQPError('NACK', 'message rejected by server'))
      this.unconfirmed.delete(params.deliveryTag)
    }
    else if (classMethod === 'basic.cancel') {
      this.consumers.delete(params.consumerTag)
      this.emit('basic.cancel', params.consumerTag)
    }
    else if (classMethod === 'channel.flow') {
      // TODO pause outgoing content frames
    }
    else {
      this.callReplyListener(classMethod, params)
    }
  }
  onHeader(classId, bodySize, properties) {
    // if (!this.incoming || this.incoming.count > 0)
    //   FRAME_ERROR unexpected header frame
    let expectedContentFrameCount = Math.ceil(bodySize / (this.frameMax - 8))
    let contentChunks = new Array(expectedContentFrameCount)
    this.incoming = Object.assign(this.incoming, {
      classId,
      bodySize,
      contentChunks,
      count: 0,
      envelope: Object.assign(this.incoming.envelope, properties, {
        durable: properties === 2
      })
    })
  }
  onBody(chunk) {
    this.incoming.contentChunks[this.incoming.count++] = chunk
    if (this.incoming.count === this.incoming.contentChunks.length) {
      let envelope = this.incoming.envelope
      let classMethod = this.incoming.classMethod
      envelope.body = Buffer.concat(this.incoming.contentChunks)
      this.incoming = null
      if (envelope.contentType === 'text/plain' && !envelope.contentEncoding) {
        envelope.body = envelope.body.toString()
      }
      else if (envelope.contentType === 'application/json' && !envelope.contentEncoding) {
        try {
          envelope.body = JSON.parse(envelope.body.toString())
        } catch (_) {
          // do nothing
        }
      }
      if (classMethod === 'basic.deliver') {
        // ensure basicConsume resolve before the message callback is invoked
        setTimeout(() => {
          let handler = this.consumers.get(envelope.consumerTag)
          try {
            handler(envelope)
          }
          catch (err) {
            this.conn.emit('error', err)
          }
        }, 1)
      }
      else if (classMethod === 'basic.return') {
        // may be received after basicPublish({mandatory: true, ...})
        this.emit('basic.return', envelope)
      }
      else if (classMethod === 'basic.get-ok') {
        this.callReplyListener(classMethod, envelope)
      }
    }
  }
  /**
   * Invoke all pending response handlers with an error
   */
  clear(err) {
    if (this.id !== 0) {
      this.active = false
    }
    this.off('basic.return')
    this.off('basic.cancel')
    for (let dequeOrDfd of this.callbacks.values()) {
      if (dequeOrDfd instanceof Deque) {
        for (let dfd of dequeOrDfd.valuesLeft()) {
          dfd.reject(err)
        }
      }
      else {
        dequeOrDfd.reject(err)
      }
    }
    this.callbacks.clear()
  }
}

function activeCheckPromise() {
  // This check is very important. The server will end the connection if we
  // attempt to use a closed channel.
  return Promise.reject(new AMQPChannelError('CH_CLOSE', 'channel is closed'))
}

for (let fullName of syncMethods) {
  Channel.prototype[camelCase(fullName)] = function (params) {
    if (!this.active) return activeCheckPromise()
    if (params && params.nowait) {
      // ignore the nowait param
      params = Object.assign({}, params, {nowait: false})
    }
    return this.conn.sendMethodAndAwaitResp(this.id, fullName, params)
  }
}

for (let fullName of asyncMethods) {
  Channel.prototype[camelCase(fullName)] = function (params) {
    if (!this.active) {
      throw new AMQPChannelError('CH_CLOSE', 'channel is closed')
    }
    this.conn.sendMethod(this.id, fullName, params)
  }
}

/**
 * @param {any} body
 *        Strings will be UTF8 encoded.
 *        Buffers will be passed as is.
 *        Objects are JSON serialized.
 */
Channel.prototype.basicPublish = function (params, body) {
  if (!this.active) return activeCheckPromise()
  if (typeof params == 'string') {
    params = {routingKey: params}
  }
  params = Object.assign({
    deliveryMode: params.durable ? 2 : 1,
    timestamp: Date.now() / 1000,
  }, params)
  if (typeof body == 'string') {
    body = Buffer.from(body, 'utf8')
    params.contentType = 'text/plain'
    params.contentEncoding = null
  }
  else if (!Buffer.isBuffer(body)) {
    body = Buffer.from(JSON.stringify(body), 'utf8')
    params.contentType = 'application/json'
    params.contentEncoding = null
  }
  this.conn.sendMethod(this.id, 'basic.publish', params)
  this.conn.sendMessage(this.id, params, body)
  if (this.mode === CH_MODE.CONFIRM) {
    // wait for basic.ack or basic.nack
    // note: Unroutable mandatory messages are acknowledged right
    //       after the basic.return method. May be ack'd out-of-order.
    const dfd = createDeferred(Promise)
    this.unconfirmed.set(this.deliveryCount++, dfd)
    return dfd.promise
  }
  return this.unblocked
}

Channel.prototype.basicConsume = function (params, fn) {
  if (!this.active) return activeCheckPromise()
  if (this.consumers == null) {
    this.consumers = new Map()
  }
  if (typeof params == 'string') {
    params = {queue: params}
  }
  if (params.nowait) {
    // ignore the nowait param
    params = Object.assign({}, params, {nowait: false})
  }
  return this.conn.sendMethodAndAwaitResp(this.id, 'basic.consume', params).then(data => {
    this.consumers.set(data.consumerTag, fn)
    return data.consumerTag
  })
}

Channel.prototype.basicCancel = function (params) {
  if (!this.active) return activeCheckPromise()
  if (typeof params == 'string') {
    params = {consumerTag: params}
  }
  if (params.nowait) {
    // ignore the nowait param
    params = Object.assign({}, params, {nowait: false})
  }
  this.consumers.delete(params.consumerTag)
  // note: server may send a few messages before basic.cancel-ok is returned
  return this.conn.sendMethodAndAwaitResp(this.id, 'basic.cancel', params)
}

Channel.prototype.confirmSelect = function () {
  if (!this.active) return activeCheckPromise()
  return this.conn.sendMethodAndAwaitResp(this.id, 'confirm.select').then(() => {
    this.mode = CH_MODE.CONFIRM
    this.unconfirmed = new Map()
  })
}

Channel.prototype.txSelect = function () {
  if (!this.active) return activeCheckPromise()
  return this.conn.sendMethodAndAwaitResp(this.id, 'tx.select').then(() => {
    this.mode = CH_MODE.TRANSACTION
  })
}

Channel.prototype.channelClose = function (params) {
  if (!this.active) return Promise.resolve()
  this.active = false
  return this.conn.sendMethodAndAwaitResp(this.id, 'channel.close', params).finally(() => {
    this.clear(new AMQPChannelError('CH_CLOSE', 'channel is closed'))
  })
}

Channel.prototype.queueDeclare = function (params) {
  if (!this.active) return Promise.resolve()
  if (typeof params == 'string') {
    params = {queue: params}
  }
  return this.conn.sendMethodAndAwaitResp(this.id, 'queue.declare', params)
}

module.exports = Channel
