'use strict'

const {AMQPChannelError} = require('./exception')
const Deque = require('./deque')

/**
 * Each AMQP connection may have several channels.
 * Channels are independent of each other and can perform different functions
 * simultaneously with other channels, the available bandwidth being shared
 * between the concurrent activities.
 */
class Pool {
  /**
   * @param {func} createResource(channelId, done)
   * @param {func} destroyResource(obj, done)
   * @param {Object} props evictionInterval, minChannels, evictionSize, idleTimeout
   */
  constructor(createResource, destroyResource, props) {
    this.evict = this.evict.bind(this)
    this.createResource = createResource
    this.destroyResource = destroyResource
    this.props = props
    this.isDraining = false
    this.pending = []
    this.drainCallback = null
    this.ids = new Deque(createRange(1, props.maxChannels))
    this.resources = {
      all: new Map(), // pooled resource -> metadata
      idle: new Deque(),
    }
    if (props.evictionInterval > 0) {
      this.evictionTimer = setTimeout(this.evict, props.evictionInterval)
    }
  }
  /**
   * @public
   */
  start() {
    if (!this.pending) {
      return
    }
    let pending = this.pending
    this.pending = null
    for (let fn of pending) {
      this.acquire(fn)
    }
    // TODO clear out queued requests if connection fails
  }
  /**
   * Create a resource for the pool
   * @param {func} done(err, obj)
   * @private
   */
  create(done) {
    let channelId = this.ids.popLeft()
    if (channelId == null) process.nextTick(() => {
      done(new AMQPChannelError('MAX_CHANNELS', 'no channels available'))
    })
    else this.createResource(channelId, (err, obj) => {
      if (err) {
        done(err)
        return
      }
      this.resources.all.set(obj, {idleStart: null})
      done(null, obj)
    })
  }
  /**
   * Politely remove an idle resource from the pool
   * @param {Object} obj
   * @param {func} done() Optional
   * @private
   */
  destroy(obj, done) {
    this.destroyResource(obj, (id) => {
      this.ids.pushLeft(id)
      this.resources.all.delete(obj)
      if (typeof done == 'function') done()
      if (this.isDraining && this.resources.all.size === 0 && typeof this.drainCallback == 'function') {
        this.drainCallback()
        this.drainCallback = null
      }
    })
  }
  /**
   * Remove a broken resource from the pool
   * @public
   */
  remove(obj, id) {
    this.resources.all.delete(obj)
    this.ids.pushLeft(id)
    if (this.isDraining && this.resources.all.size === 0 && typeof this.drainCallback == 'function') {
      this.drainCallback()
      this.drainCallback = null
    }
  }
  /**
   * Get an idle resource or create a new one
   * @param {func} done(err, obj)
   * @public
   */
  acquire(done) {
    if (this.isDraining) {
      process.nextTick(() => done(new AMQPChannelError('EDRAIN', 'acquire failed; channel pool is draining')))
      return
    }
    if (this.pending) {
      this.pending.push(done)
      return
    }
    let obj = this.resources.idle.popLeft()
    if (obj == null) {
      this.create(done)
    }
    else {
      let meta = this.resources.all.get(obj)
      meta.idleStart = null
      process.nextTick(() => done(null, obj))
    }
  }
  /**
   * Return a loaned resource back to the pool
   * @param {Object} obj
   * @param {func} done() Optional
   * @public
   */
  release(obj, done) {
    if (this.isDraining) {
      this.destroy(obj, done)
      return
    }
    let meta = this.resources.all.get(obj)
    if (meta == null || meta.idleStart != null) {
      // do nothing if already destroyed or released
      return
    }
    meta.idleStart = Date.now()
    this.resources.idle.pushLeft(obj)
    if (typeof done == 'function') process.nextTick(done)
  }
  /**
   * Find and destroy idle resources
   * @private
   */
  evict() {
    let len = Math.min(this.resources.idle.size - this.props.minChannels, this.props.evictionSize)
    let now = Date.now()
    var obj, meta
    for (let index = 0; index < len; index++) {
      obj = this.resources.idle.peekRight()
      meta = this.resources.all.get(obj)
      if (now - meta.idleStart > this.props.idleTimeout) {
        this.resources.idle.popRight()
        this.destroy(obj)
      }
      // resources are sorted by most-least recently used
      // so we can stop once we find one that shouldn't be evicted
      else break
    }
  }
  /**
   * Gracefully empty the pool.
   * - idle resources are destroyed immediately
   * - loaned resources are destroyed once returned
   * @param {func} done() Invoked once all resources have been destroyed
   * @public
   */
  drain(done) {
    if (this.isDraining) {
      return // already being drained
    }
    this.isDraining = true
    clearTimeout(this.evictionTimer)
    if (this.pending) for (let fn of this.pending) {
      this.acquire(fn)
    }
    this.pending = null
    if (this.resources.all.size === 0 && typeof done == 'function') {
      done()
      return
    }
    this.drainCallback = done
    this.evictionTimer = null
    for (let obj of this.resources.idle.valuesRight()) {
      this.destroy(obj)
    }
    // ... wait for loaned resources to return ...
    // see #destroy(obj, done)
  }
}

function createRange(start, end) {
  return new Uint16Array(end - start + 1).map((_, i) => start + i)
}

module.exports = Pool
