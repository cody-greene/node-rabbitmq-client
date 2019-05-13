'use strict'
const {AMQPChannelError} = require('./exception')

// Maintains a Stack of available IDs
class ChannelIDPool {
  constructor(maxChannels) {
    this.max = maxChannels
    this.sequence = 1
    this.used = []
    // this.leased = new Set()
  }
  clear() {
    this.sequence = 1
    this.used = []
  }
  acquire() {
    if (this.sequence >= this.max) {
      throw new AMQPChannelError('MAX_CHANNELS', 'no channels available')
    }
    if (this.used.length > 0) {
      return this.used.pop()
    }
    return this.sequence++
  }
  release(id) {
    // warning: unsafe. does not check for duplicates or invalid ids
    this.used.push(id)
  }
}

module.exports = ChannelIDPool
