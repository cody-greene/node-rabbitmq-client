'use strict'

const Deque = require('./deque')

const SYNCHRONOUS_METHODS = [
  'access.request',
  'basic.cancel',
  'basic.consume',
  'basic.get',
  'basic.qos',
  'basic.recover',
  'channel.close',
  'channel.flow',
  'channel.open',
  'confirm.select',
  'connection.close',
  'connection.open',
  'exchange.bind',
  'exchange.declare',
  'exchange.delete',
  'exchange.unbind',
  'queue.bind',
  'queue.declare',
  'queue.delete',
  'queue.purge',
  'queue.unbind',
  'tx.commit',
  'tx.rollback',
  'tx.select',
]
const ASYNC_METHODS = [
  'basic.ack',
  'basic.deliver',
  'basic.get-empty',
  'basic.nack',
  'basic.publish',
  'basic.recover-async',
  'basic.reject',
  'basic.return',
  'connection.blocked',
  'connection.unblocked',
]

class Channel {
  constructor(id, conn) {
    this.conn = conn
    this.id = id
    this.callbacks = new Map()
    this.awaitingContent = null
    this._consumers = null
    this._incoming = null
  }
  /**
   * @public
   */
  release() {
    this.conn.pool.release(this)
  }
  /**
   * Subscribe to asynchronous AMQP methods
   * @param {string} classMethod e.g. "basic.deliver"
   * @param {func} fn The handler to call
   * @public
   */
  on(classMethod, fn) {
    this.conn.on(`${this.id}:${classMethod}`, fn)
  }
  /**
   * @param {string} classMethod e.g. "basic.deliver"
   * @param {func} fn Optional. The handler to remove
   * @public
   */
  off(classMethod, fn) {
    let eventName = this.id + ':' + classMethod
    if (typeof fn == 'function') {
      this.conn.removeListener(eventName, fn)
    }
    else if (classMethod != null) {
      this.conn.removeAllListeners(eventName)
    }
  }
  /**
   * Save a handler (run-once) for an AMQP synchronous method response
   * @private
   */
  save(classMethod, fn) {
    let group = this.callbacks.get(classMethod)
    if (group == null) {
      this.callbacks.set(classMethod, fn)
    }
    else if (typeof group == 'function') {
      this.callbacks.set(classMethod, new Deque([group, fn]))
    }
    else {
      this.callbacks.get(classMethod).pushRight(fn)
    }
  }
  /**
   * Invoke a pending response handler
   * e.g. 'channel.open' -> 'channel.open-ok'
   * @private
   */
  trigger(classMethod, params) {
    let group = this.callbacks.get(classMethod)
    if (this._incoming != null) {
      // TODO error: unexpected frame, awaiting content
    }
    // methodDef.content === true
    else if (['basic.deliver', 'basic.return', 'basic.get-ok'].indexOf(classMethod) !== -1) {
      // TODO wait for header & content frames
      // TODO basic.return (async), basic.deliver (async), basic.get-ok
      this._incoming = {classMethod, envelope: params}
    }
    else if (typeof group == 'function') {
      this.callbacks.delete(classMethod)
      // FIXME try-catch
      group(null, params)
    }
    else if (group != null && group.size > 0) {
      // FIXME try-catch
      group.popLeft()(null, params)
    }
    else {
      this.conn.emit(`${this.id}:${classMethod}`, params)
    }
  }
  onHeader(classId, bodySize, properties) {
    // if (!this._incoming || this._incoming.count > 0)
    //   TODO FRAME_ERROR unexpected header frame
    let frameMax = this.conn.props.frameMax
    let expectedContentFrameCount = Math.ceil(bodySize / (frameMax - 8))
    let contentChunks = new Array(expectedContentFrameCount)
    this._incoming = Object.assign(this._incoming, {
      classId,
      bodySize,
      contentChunks,
      count: 0,
      envelope: Object.assign(this._incoming.envelope, properties)
    })
  }
  onBody(chunk) {
    this._incoming.contentChunks[this._incoming.count++] = chunk
    if (this._incoming.count === this._incoming.contentChunks.length) {
      let envelope = this._incoming.envelope
      let classMethod = this._incoming.classMethod
      envelope.body = Buffer.concat(this._incoming.contentChunks)
      this._incoming = null

      if (classMethod = 'basic.deliver') {
        let fn = this._consumers.get(envelope.consumerTag)
        // TODO try-catch
        fn(envelope)
      }
      else {
        // TODO hmmm..
        console.log(classMethod, envelope)
      }
    }
  }
  /**
   * Invoke all pending response handlers with an error
   * @private
   */
  clear(err) {
    // TODO clear async listeners
    for (let group of this.callbacks.values()) {
      if (typeof group == 'function') {
        // FIXME try-catch
        group(err)
      }
      else for (let fn of group.clear()) {
        // FIXME try-catch
        fn(err)
      }
    }
  }
}

for (let classMethod of SYNCHRONOUS_METHODS) {
  let [className, methodName] = classMethod.split('.')
  let alias = className + methodName.charAt(0).toUpperCase() + methodName.slice(1)
  Channel.prototype[alias] = function (params, done) {
    this.conn.sendMethod(this.id, className, methodName, params, done)
  }
}
for (let classMethod of ASYNC_METHODS) {
  let [className, methodName] = classMethod.split('.')
  let alias = className + methodName.charAt(0).toUpperCase() + methodName.slice(1)
  Channel.prototype[alias] = function (params, done) {
    this.conn.sendMethodAsync(this.id, className, methodName, params)
    if (done) process.nextTick(done)
  }
}

/**
 * @param {object} params Combined property-bag for basic.publish params and content headers
 * @param {string?} params.exchange The exchange name
 * @param {string} params.routingKey e.g. The queue name
 * @param {bool} params.mandatory If true, unroutable messages are returned via basic.return
 * @param {bool} params.immediate If true, messages not immediately sent to a consumer are returned
 * @param {string?} params.contentType Auto for text, json
 * @param {string?} params.contentEcoding e.g. gzip
 * @param {number?} params.deliveryMode 1 (non-persist), 2 (perist)
 * @param {number?} params.priority 0-9
 * @param {string?} params.correlationId
 * @param {string?} params.replyTo
 * @param {string?} params.expiration
 * @param {string?} params.messageId
 * @param {number?} params.timestamp Unix timestamp. Auto.
 * @param {string?} params.type
 * @param {string?} params.userId
 * @param {string?} params.appId
 * @param {any} body
 *        Strings will be UTF8 encoded.
 *        Buffers will be passed as is.
 *        Objects are JSON serialized.
 * @param {func?} done()
 */
Channel.prototype.basicPublish = function (params, body, done) {
  params = Object.assign({
    // contentType: 'application/json',
    // headers: {}
    // deliveryMode: 1 (non-persist) 2 (persistent)
    timestamp: Date.now() / 1000,
  }, params)
  if (typeof body == 'string') {
    body = Buffer.from(body, 'utf8')
    params.contentType = params.contentType || 'text/plain'
  }
  else if (!Buffer.isBuffer(body)) {
    body = Buffer.from(JSON.stringify(body), 'utf8')
    params.contentType = params.contentType || 'application/json'
  }
  this.conn.sendMethodAsync(this.id, 'basic', 'publish', params)
  this.conn.sendMessage(this.id, params, body)
  if (done) process.nextTick(done)
}

/**
 * TODO disallow noWait
 * @param {object} params
 *        + queue, consumerTag, noLocal, noAck, exclusive, noWait, arguments
 * @param {func} fn(body, meta)
 *        + consumerTag, deliveryTag, redelivered, exchange, routingKey
 *        + content-properties
 * @param {func} done(err, consumerTag)
 */
Channel.prototype.basicConsume = function (params, fn, done) {
  if (this._consumers == null) {
    this._consumers = new Map()
  }
  this.conn.sendMethod(this.id, 'basic', 'consume', params, (err, {consumerTag}) => {
    if (err) return done(err)
    this._consumers.set(consumerTag, fn)
    done(null, consumerTag)
  })
}

/**
 * You may want to use basicNack({multiple: true}) afterwards
 * @param {string} params.consumerTag
 * @param {bool} params.noWait
 * @param {func} done()
 */
Channel.prototype.basicCancel = function (params, done) {
  this.conn.sendMethod(this.id, 'basic', 'cancel', params, (err) => {
    this._consumers.delete(params.consumerTag)
    done(err)
  })
}

module.exports = Channel
