'use strict'
const Channel = require('./channel')
const ChannelIDPool = require('./id-pool')
const {AMQPChannelError} = require('./exception')
const {createDeferred} = require('./util')

/**
 * Tracks open channels. With this we can wait for all channels to close before
 * finally closing the connection as well.
 */
module.exports = class ChannelManager {
  // draining: ?Deferred<void>
  // pending: ?Deferred<void>
  // ids: ChannelIDPool
  // items: Map<number, Channel>
  constructor(maxChannels) {
    this.draining = null
    this.pending = createDeferred(Promise)
    this.ids = new ChannelIDPool(maxChannels)
    this.items = new Map()

    // ignore unhandled rejection
    // e.g. the pool is draining and no one is waiting for a channel
    this.pending.promise.catch(err => {})
  }
  async create(conn) {
    if (this.draining) {
      throw new AMQPChannelError('EDRAIN', 'channel creation failed; connection is closing')
    }
    if (this.pending) {
      await this.pending.promise
    }
    const id = this.ids.acquire()
    const ch = new Channel(id, conn)
    this.items.set(id, ch)
    await ch.channelOpen()
    return ch
  }
  destroy(ch) {
    return ch.channelClose({replyCode: 200, classId: 0, methodId: 0}).finally(() => {
      this.items.delete(ch.id)
      this.ids.release(ch.id)
      this.checkDrain()
    })
  }
  get(id) {
    return this.items.get(id)
  }
  // remove a single channel
  delete(id, err) {
    const ch = this.items.get(id)
    this.items.delete(id)
    this.ids.release(id)
    if (err) {
      ch.clear(err)
    }
    this.checkDrain()
  }
  clear(err, clearPending) {
    this.items.forEach(ch => ch.clear(err))
    this.items.clear()
    this.ids.clear()
    this.checkDrain()
    this.draining = null
    if (clearPending && this.pending) {
      this.pending.reject(err)
    }
    if (clearPending || !this.pending) {
      this.pending = createDeferred(Promise)
      this.pending.promise.catch(err => {}) // ignore unhandled rejection
    }
  }
  async drain() {
    if (this.draining) {
      return await this.draining.promise
    }
    if (this.pending) {
      this.pending.reject(new AMQPChannelError('EDRAIN', 'channel creation failed; connection is closing'))
      // this.pending = null
    }
    if (!this.items.size) {
      return // nothing to wait for
    }
    this.draining = createDeferred(Promise)
    await this.draining.promise
  }
  checkDrain() {
    if (this.draining && !this.items.size) {
      this.draining.resolve()
      // leave this defined & block futher channel creation
      // this.draining = null
    }
  }
  start() {
    if (!this.pending) {
      return
    }
    this.pending.resolve()
    this.pending = null
  }
}
