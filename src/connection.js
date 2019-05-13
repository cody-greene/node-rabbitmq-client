'use strict'
const net = require('net')
const tls = require('tls')
const EventEmitter = require('events')

const {AMQPConnectionError, AMQPChannelError} = require('./exception')
const {getExpDelay} = require('./util')
const codec = require('./codec')
const Channel = require('./channel')
const normalizeOptions = require('./normalize')
const ChannelManager = require('./channel-manager')
const CLIENT_PROPERTIES = (pkg => ({
  product: pkg.name,
  version: pkg.version,
  platform: `${process.platform}-node.js-${process.version}`,
  capabilities: {
    'basic.nack': true,
    'connection.blocked': true,
    publisher_confirms: true,
    exchange_exchange_bindings: true,
    // https://www.rabbitmq.com/consumer-cancel.html
    consumer_cancel_notify: true,
    // https://www.rabbitmq.com/auth-notification.html
    authentication_failure_close: true,
  }
}))(require('../package.json'))
const EMPTY = Object.create(null)
const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 3,
}

class Connection extends EventEmitter {
  constructor(propsOrUrl) {
    super()
    this.handleChunk = this.handleChunk.bind(this)
    this.connect = this.connect.bind(this)
    this.opt = normalizeOptions(propsOrUrl)
    this.channels = new ChannelManager()

    // Not really a channel, so keep it out of the ChannelManager
    this.ch0 = new Channel(0, this)

    this.readyState = READY_STATE.CONNECTING
    this.socket = null
    this.connectionTimer = null
    this.retryTimer = null
    this.retryCount = 0
    this.blocked = false
    this.hostIndex = 0
    this.connect()
  }

  get unblocked() {
    return !this.blocked
      && this.socket.writableLength < this.socket.writableHighWaterMark
  }

  reconnect() {
    this.readyState = READY_STATE.CLOSED
    clearTimeout(this.connectionTimer)
    this.connectionTimer = null
    const delay = getExpDelay(this.opt.retryLow, this.opt.retryHigh, this.retryCount++)
    this.retryTimer = setTimeout(this.connect, delay)
  }

  connect() {
    this.readyState = READY_STATE.CONNECTING
    this.retryTimer = null
    if (this.socket) {
      this.socket.destroy()
    }
    this.socket = this.createSocket()
    this.createConnectionTimeout(this.opt.connectionTimeout)
    this.socket.on('drain', () => {
      if (!this.blocked) {
        this.emit('drain')
      }
    })
    this.socket.on('error', err => {
      if (!this.channels.draining) {
        this.reconnect()
      }
      this.ch0.clear(err)
      this.channels.clear(err, false)
      if (this.retryCount <= 1) {
        // suppress spam during reconnect
        this.emit('error', err)
      }
    })
    this.socket.on('end', () => {
      if (this.readyState === READY_STATE.CLOSED) {
        // ignore
        return
      }
      this.reconnect()
      const err = new AMQPConnectionError('CONN_CLOSE', 'socket closed unexpectedly by server')
      this.ch0.clear(err)
      this.channels.clear(err, false)
      if (this.retryCount <= 1) {
        // suppress spam during reconnect
        this.emit('error', err)
      }
    })
    this.socket.once('data', chunk => {
      if (chunk.toString('utf8', 0, 4) === 'AMQP') {
        let actual = [chunk[5], chunk[6], chunk[7]].join('-')
        let message = `this version of AMQP is not supported; the server suggests ${actual}`
        this.readyState = READY_STATE.CLOSED
        this.emit('error', new AMQPConnectionError('VERSION_MISMATCH', message))
        return
      }
      this.handleChunk(chunk)
      this.socket.on('data', this.handleChunk)
    })
    this.negotiate().catch(err => {
      // already handled
    })
  }

  mux(channelId, fullName, params) {
    // console.error('>>', channelId, fullName)
    switch (fullName) {
      case 'connection.close':
        this.ch0.connectionCloseOk()
        this.socket.end()
        if (!this.channels.draining) {
          this.reconnect()
        }
        let err = new AMQPConnectionError(params)
        this.ch0.clear(err)
        this.channels.clear(err, false)
        if (!this.channels.draining) {
          this.emit('error', err)
        }
        break
      case 'connection.blocked':
        this.blocked = true
        this.emit('connection.blocked', params.reason)
        break
      case 'connection.unblocked':
        this.blocked = false
        if (this.unblocked) {
          this.emit('drain')
        }
        break
      case 'channel.close':
        this.sendMethod(channelId, 'channel.close-ok')
        this.channels.delete(channelId, new AMQPChannelError(params))
        break
      default:
        const ch = channelId === 0 ? this.ch0 : this.channels.get(channelId)
        ch.trigger(fullName, params)
    }
  }

  createConnectionTimeout(ms) {
    if (ms > 0) {
      this.connectionTimer = setTimeout(() => {
        this.readyState = READY_STATE.CLOSED
        this.socket.destroy()
        this.emit('error', new AMQPConnectionError('ETIMEDOUT', 'connection timed out'))
      }, ms)
      this.socket.on('connect', () => {
        clearTimeout(this.connectionTimer)
        this.connectionTimer = null
      })
    }
  }

  createHeartbeatTimeout(seconds) {
    if (seconds > 0) {
      // convert to ms and multiply x2.5
      this.socket.setTimeout(seconds * 2500, () => {
        this.readyState = READY_STATE.CLOSED
        this.socket.destroy()
        this.emit('error', new AMQPConnectionError('ETIMEDOUT', 'socket timed out'))
      })
    }
  }

  acquire() {
    return this.channels.create(this)
  }

  async close() {
    if (this.channels.draining) {
      return
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.channels.drain()
    try {
      if (this.readyState === READY_STATE.OPEN) {
        await this.ch0.connectionClose({replyCode: 200, classId: 0, methodId: 0})
      }
    } finally {
      this.readyState = READY_STATE.CLOSED
      this.socket.end()
      this.socket.destroy()
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer)
        this.connectionTimer = null
      }
    }
  }

  /**
   * Establish connection parameters with the server, including:
   * - authentication
   * - max frame size
   * - max channels
   * - heartbeat
   */
  async negotiate() {
    this.socket.write(codec.PROTOCOL_HEADER)
    let serverParams = await this.ch0.addReplyListener('connection.start')
    // TODO support EXTERNAL mechanism, i.e. x509 peer verification
    // https://github.com/rabbitmq/rabbitmq-auth-mechanism-ssl
    // serverParams.mechanisms === 'EXTERNAL PLAIN AMQPLAIN'
    this.ch0.connectionStartOk({
      locale: 'en_US',
      mechanism: 'PLAIN',
      response: [null, this.opt.username, this.opt.password].join(String.fromCharCode(0)),
      clientProperties: CLIENT_PROPERTIES
    })
    let params = await this.ch0.addReplyListener('connection.tune')
    let channelMax = params.channelMax > 0
      ? Math.min(this.opt.maxChannels, params.channelMax)
      : this.opt.maxChannels
    let frameMax = params.frameMax > 0
      ? Math.min(this.opt.frameMax, params.frameMax)
      : this.opt.frameMax
    let heartbeat = Math.min(params.heartbeat, this.opt.heartbeat)
    this.ch0.connectionTuneOk({channelMax, frameMax, heartbeat})
    await this.ch0.connectionOpen({virtualHost: this.opt.vhost})
    this.readyState = READY_STATE.OPEN
    this.createHeartbeatTimeout(this.opt.heartbeat)
    this.retryCount = 0
    this.channels.start()
    this.emit('connection')
  }

  /**
   * Write an AMQP method frame to the socket and await the response frame.
   * @param {number} channelId
   * @param {string} fullName e.g. 'basic.get'
   * @param {object?} params
   * @return Promise<any>
   */
  sendMethodAndAwaitResp(channelId, fullName, params) {
    this.sendMethod(channelId, fullName, params)
    const ch = channelId === 0 ? this.ch0 : this.channels.get(channelId)
    return ch.addReplyListener(fullName + '-ok')
  }

  sendMethod(channelId, fullName, params) {
    if (params == null) {
      params = EMPTY
    }
    let [className, methodName] = fullName.split('.')
    let frame = codec.encodeMethod(channelId, className, methodName, params)
    this.socket.write(frame)
  }

  sendMessage(channelId, params, body) {
    let contentFrames = codec.encodeMessage(channelId, params, body, this.opt.frameMax)
    for (let frame of contentFrames) {
      this.socket.write(frame)
    }
  }

  handleChunk(chunk) {
    let [evt, rest] = codec.decodeFrame(chunk)
    if (evt) {
      if (evt.type === 'heartbeat') {
        this.socket.write(codec.HEARTBEAT_FRAME)
      }
      else if (evt.type === 'method') {
        this.mux(evt.channelId, evt.className + '.' + evt.methodName, evt.params)
      }
      else if (evt.type === 'header') {
        let channel = this.channels.get(evt.channelId)
        channel.onHeader(evt.classId, evt.bodySize, evt.properties)
      }
      else if (evt.type === 'body') {
        let channel = this.channels.get(evt.channelId)
        channel.onBody(evt.payload)
      }
    }
    if (rest != null) {
      // might be more than 1 frame in a chunk!
      this.handleChunk(rest)
    }
  }

  getNextHost() {
    // round-robin
    const index = this.hostIndex
    this.hostIndex = (this.hostIndex + 1) % this.opt.hosts.length
    return this.opt.hosts[index]
  }

  createSocket() {
    const opt = this.opt
    const host = this.getNextHost()
    if (!opt.tls) {
      return net.connect({
        port: host.port,
        host: host.hostname,
        writableHighWaterMark: opt.writableHighWaterMark,
      })
    }
    if (opt.tls) {
      return tls.connect({
        port: host.port,
        host: host.hostname,
        writableHighWaterMark: opt.writableHighWaterMark,
        rejectUnauthorized: opt.rejectUnauthorized,
        pfx: opt.pfx,
        key: opt.key,
        passphrase: opt.passphrase,
        cert: opt.cert,
        ca: opt.ca,
      })
    }
  }
}

module.exports = Connection
