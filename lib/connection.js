'use strict'
const net = require('net')
const tls = require('tls')
const EventEmitter = require('events')
const pick = require('lodash/pick')

const {AMQPConnectionError, AMQPChannelError} = require('./exception')
const codec = require('./codec')
const Pool = require('./pool')
const Channel = require('./channel')
const normalizeOptions = require('./normalize')
const CLIENT_PROPERTIES = (pkg => ({
  product: pkg.name,
  version: pkg.version,
  platform: `node.js-${process.version}-${process.platform}`,
}))(require('../package.json'))
const EMPTY = Object.create(null)
const READY_STATE = {
  NONE: 0,
  OPEN: 1,
  CLOSE: 2,
}

class Connection extends EventEmitter {
  // socket: net.Socket

  // readyState: READY_STATE.*

  constructor(props) {
    super()
    this.createChannel = this.createChannel.bind(this)
    this.destroyChannel = this.destroyChannel.bind(this)
    this.handleChunk = this.handleChunk.bind(this)

    this.props = normalizeOptions(props)
    this.pool = new Pool(this.createChannel, this.destroyChannel, this.props)
    this.channels = new Map()
    this.channels.set(0, new Channel(0, this))
    this.readyState = READY_STATE.NONE
    this.socket = this.createSocket()
    this.createConnectionTimeout(this.props.connectionTimeout)

    this.socket.on('error', err => {
      // err.code === 'ECONNRESET'
      // TODO all other operations fail until connection reestablished
      // TODO exponential retry: establish new connection
      clearTimeout(this.connectionTimer)
      this.connectionTimer = null
      this.emit('error', err)
    })

    this.socket.once('end', () => {
      // TODO don't err if closing on purpose
      if (this.readyState === READY_STATE.CLOSE) {
        // ignore
      }
      else if (this.readyState === READY_STATE.NONE) {
        // FIXME can happen if server is not ready
        this.emit('error', new AMQPConnectionError('CONN_CLOSE', 'socket closed abruptly during opening handshake'))
      }
      else {
        this.emit('error', new AMQPConnectionError('CONN_CLOSE', 'socket closed abruptly by peer'))
      }
    })

    this.socket.once('data', chunk => {
      if (chunk.toString('utf8', 0, 4) === 'AMQP') {
        let actual = [chunk[5], chunk[6], chunk[7]].join('-')
        let message = `this version of AMQP is not supported; the server suggests ${actual}`
        this.readyState = READY_STATE.CLOSE
        this.emit('error', new AMQPConnectionError('VERSION_MISMATCH', message))
        return
      }
      this.handleChunk(chunk)
      this.socket.on('data', this.handleChunk)
    })

    this.negotiate(err => {
      if (err) {
        if (err.code) {
          this.sendMethodAsync(0, 'connection', 'close-ok')
        }
        this.readyState = READY_STATE.CLOSE
        this.socket.end()
        this.emit('error', err)
        return
      }
      this.readyState = READY_STATE.OPEN
      this.createSocketTimeout(this.props.heartbeat)
      this.pool.start()
      this.emit('ready')
    })
  }

  mux(channelId, className, methodName, params) {
    let channel = this.channels.get(channelId)
    if (className === 'connection' && methodName === 'close') {
      this.sendMethodAsync(0, 'connection', 'close-ok')
      this.readyState = READY_STATE.CLOSE
      this.socket.end()
      // TODO drop channel pool and reject handlers with err
      this.emit('error', new AMQPConnectionError(params))
    }
    else if (className === 'channel' && methodName === 'close') {
      this.sendMethodAsync(channelId, 'channel', 'close-ok')
      this.pool.remove(channel, channelId)
      this.channels.delete(channelId)
      channel.clear(new AMQPChannelError(params))
    }
    else {
      channel.trigger(className + '.' + methodName, params)
    }
  }

  createChannel(id, done) {
    let ch = new Channel(id, this)
    this.channels.set(id, ch)
    ch.channelOpen(null, err => {
      if (err) {
        this.channels.delete(id)
        done(err)
      }
      else {
        done(null, ch)
      }
    })
  }

  destroyChannel(obj, done) {
    this.sendMethod(obj.id, 'channel', 'close', {replyCode: 200, classId: 0, methodId: 0}, () => {
      // FIXME ignoring callback-err
      this.channels.delete(obj.id)
      done(obj.id)
    })
  }

  createConnectionTimeout(ms) {
    if (ms > 0) {
      this.connectionTimer = setTimeout(() => {
        this.readyState = READY_STATE.CLOSE
        this.socket.destroy()
        this.emit('error', new AMQPConnectionError('ETIMEDOUT', 'connection timed out'))
      }, ms)
      this.socket.on('connect', () => {
        clearTimeout(this.connectionTimer)
        this.connectionTimer = null
      })
    }
  }

  createSocketTimeout(seconds) {
    if (seconds > 0) {
      this.socket.setTimeout(seconds * 2500, () => {
        this.readyState = READY_STATE.CLOSE
        this.socket.destroy()
        this.emit('error', new AMQPConnectionError('ETIMEDOUT', 'connection timed out'))
      })
    }
  }

  /**
   * @param {func} done(err, channel)
   * @public
   */
  acquire(done) {
    this.pool.acquire(done)
  }

  /**
   * Attempt to gracefully close the connection by draining the channel pool
   * @param {func} done Will be invoked when the socket is fully closed
   * @public
   */
  close(done) {
    this.pool.drain(() => {
      this.sendMethod(0, 'connection', 'close', {replyCode: 200, classId: 0, methodId: 0}, () => {
        // ignore errors on this rpc
        this.readyState = READY_STATE.CLOSE
        if (typeof done == 'function') this.socket.on('close', done)
      })
      this.socket.end()
    })
  }

  // TODO make this better
  assertReply(className, methodName, done) {
    const fn = evt => {
      if (evt.className === 'connection' && evt.methodName === 'close') {
        this.removeListener('frame', fn)
        done(new AMQPConnectionError(evt.params))
        return
      }
      if (evt.channelId === 0 && evt.className === className && evt.methodName === methodName) {
        this.removeListener('frame', fn)
        done(null, evt.params)
        return
      }
      done(new AMQPConnectionError('UNEXPECTED_FRAME', 'unexpected frame from the server during opening handshake'))
    }
    this.on('frame', fn)
  }

  /**
   * Establish connection parameters with the server, including:
   * - authentication
   * - max frame size
   * - max channels
   * - heartbeat
   */
  negotiate(done) {
    this.socket.write(codec.PROTOCOL_HEADER)
    this.assertReply('connection', 'start', (err, serverParams) => {
      if (err) return done(err)
      // TODO choose auth mechanism (intelligently)
      // let mechanisms = serverParams.mechanisms // 'EXTERNAL PLAIN AMQPLAIN'
      this.sendMethodAsync(0, 'connection', 'start-ok', {
        locale: 'en_US',
        mechanism: 'PLAIN',
        response: [null, this.props.username, this.props.password].join(String.fromCharCode(0)),
        clientProperties: CLIENT_PROPERTIES
      })
      this.assertReply('connection', 'tune', (err, params) => {
        if (err) return done(err)
        this.props.maxChannels = params.channelMax > 0
          ? Math.min(this.props.maxChannels, params.channelMax)
          : this.props.maxChannels
        this.props.frameMax = params.frameMax > 0
          ? Math.min(this.props.frameMax, params.frameMax)
          : this.props.frameMax
        this.props.heartbeat = Math.min(params.heartbeat, this.props.heartbeat)
        this.sendMethodAsync(0, 'connection', 'tune-ok', {
          channelMax: this.props.maxChannels,
          frameMax: this.props.frameMax,
          heartbeat: this.props.heartbeat,
        })
        this.sendMethodAsync(0, 'connection', 'open', {
          virtualHost: this.props.vhost
        })
        this.assertReply('connection', 'open-ok', done)
      })
    })
  }

  /**
   * Write an AMQP method frame to the socket and await the response frame.
   * @param {number} channelId
   * @param {string} className
   * @param {string} methodName
   * @param {object?} params
   * @param {func} done
   */
  sendMethod(channelId, className, methodName, params, done) {
    if (typeof params == 'function') {
      done = params
      params = EMPTY
    }
    if (params == null) {
      params = EMPTY
    }
    try {
      let frame = codec.encodeMethod(channelId, className, methodName, params)
      // console.log('>> ' + frame.toString('base64'))
      this.socket.write(frame)
    }
    catch (err) {
      done(err)
      return
    }
    this.channels.get(channelId).save(className + '.' + methodName + '-ok', done)
  }

  /**
   * Async, in this case means we're not expecting a response frame
   */
  sendMethodAsync(channelId, className, methodName, params) {
    if (params == null) {
      params = EMPTY
    }
    let frame = codec.encodeMethod(channelId, className, methodName, params)
    // console.log('>> ' + frame.toString('base64'))
    this.socket.write(frame)
  }

  sendMessage(channelId, params, body) {
    let contentFrames = codec.encodeMessage(channelId, params, body, this.props.frameMax)
    for (let frame of contentFrames) {
      this.socket.write(frame)
    }
  }

  handleChunk(chunk) {
    let [evt, rest] = codec.decodeFrame(chunk)
    if (evt) {
      this.emit('frame', evt)
      if (evt.type === 'heartbeat') {
        this.socket.write(codec.HEARTBEAT_FRAME)
      }
      else if (evt.type === 'method') {
        if (this.readyState === READY_STATE.OPEN) {
          this.mux(evt.channelId, evt.className, evt.methodName, evt.params)
        }
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

  createSocket() {
    let props = this.props
    if (!props.protocol || props.protocol === 'amqp:') {
      return net.connect(props.port, props.hostname)
    }
    else if (props.protocol === 'amqps:') {
      return tls.connect(props.port, props.hostname, pick(props, [
        'rejectUnauthorized',
        'pfx',
        'key',
        'passphrase',
        'cert',
        'ca'
      ]))
    }
  }
}

module.exports = Connection
