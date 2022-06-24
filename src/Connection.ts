import net, {Socket} from 'node:net'
import tls from 'node:tls'
import EventEmitter from 'node:events'
import {AMQPConnectionError, AMQPChannelError, AMQPError} from './exception'
import {createAsyncReader, expBackoff, createDeferred, Deferred} from './util'
import * as codec from './codec'
import Channel from './Channel'
import normalizeOptions, {ConnectionOptions} from './normalize'
import {READY_STATE, Envelope, MethodParams, Publisher, PublisherProps, MessageBody, DataFrame} from './types'
import SortedMap from './SortedMap'
import Consumer, {ConsumerProps, ConsumerHandler} from './Consumer'
import RPCClient, {RPCProps} from './RPCClient'

/** @internal */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) =>
      timer = setTimeout(() => reject(new AMQPError('TIMEOUT', msg)), ms))
  ]).finally(() => {
    clearTimeout(timer)
  })
}

const CLIENT_PROPERTIES = (pkg => ({
  information: pkg.homepage,
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

declare interface Connection {
  /** The connection is successfully (re)established */
  on(name: 'connection', cb: () => void): this;
  /** The rabbitmq server is low on resources. Message publishers should pause.
   * The outbound side of the TCP socket is blocked until "connection.unblocked"
   * is received.  https://www.rabbitmq.com/connection-blocked.html */
  on(name: 'connection.blocked', cb: (reason: string) => void): this;
  /** The rabbitmq server is accepting new messages. */
  on(name: 'connection.unblocked', cb: () => void): this;
  on(name: 'error', cb: (err: any) => void): this;
}

class Connection extends EventEmitter {
  /** @internal */
  _opt: ReturnType<typeof normalizeOptions>
  /** @internal */
  _socket: Socket

  /** @internal */
  _state: {
    channelMax: number,
    frameMax: number,
    hostIndex: number,
    retryCount: number,
    retryTimer?: NodeJS.Timeout,
    connectionTimer?: NodeJS.Timeout,
    readyState: READY_STATE,
    leased: SortedMap<number, Channel>,
    /** Resolved when connection is (re)established. Rejected when the connection is closed. */
    onConnect: Deferred<void>,
    /** Resolved when all Channels are closed */
    onEmpty: Deferred<void>
  }

  constructor(propsOrUrl?: string|ConnectionOptions) {
    super()
    this._connect = this._connect.bind(this)
    this._opt = normalizeOptions(propsOrUrl)
    this._state = {
      channelMax: this._opt.maxChannels,
      frameMax: this._opt.frameMax,
      onEmpty: createDeferred(),
      // ignore unhandled rejection e.g. no one is waiting for a channel
      onConnect: createDeferred(true),
      connectionTimer: undefined,
      hostIndex: 0,
      leased: new SortedMap(),
      readyState: READY_STATE.CONNECTING,
      retryCount: 1,
      retryTimer: undefined
    }

    this._socket = this._connect()
  }

  /**
   * Allocate and return a new AMQP Channel. You MUST close the channel
   * yourself. Will wait for connect/reconnect when necessary.
   */
  async acquire(): Promise<Channel> {
    if (this._state.readyState >= READY_STATE.CLOSING)
      throw new AMQPConnectionError('CLOSING', 'channel creation failed; connection is closing')
    if (this._state.readyState === READY_STATE.CONNECTING) {
      // TODO also wait for connection.unblocked
      await raceWithTimeout(this._state.onConnect.promise, this._opt.acquireTimeout,
        'channel aquisition timed out')
    }

    // choosing an available channel id from this SortedMap is certainly slower
    // than incrementing a counter from 1 to MAX_CHANNEL_ID. However
    // this method allows for safely reclaiming old IDs once MAX_CHANNEL_ID+1
    // channels have been created. Also this function runs in O(log n) time
    // where n <= 0xffff. Which means ~16 tree nodes in the worst case. So it
    // shouldn't be noticable. And who needs that many Channels anyway!?
    const id = this._state.leased.pick()
    if (id > this._state.channelMax)
      throw new Error('maximum number of AMQP Channels already open')
    const ch = new Channel(id, this)
    this._state.leased.set(id, ch)
    await ch._invoke('channel.open', {})
    return ch
  }

  /**
   * Wait for channels to close and then end the connection. Will not
   * automatically close any channels, giving you the chance to ack/nack any
   * outstanding messages while preventing new channels.
   */
  async close(): Promise<void> {
    if (this._state.readyState === READY_STATE.CLOSED)
      return
    if (this._state.readyState === READY_STATE.CLOSING)
      return new Promise(resolve => this._socket.once('close', resolve))

    if (this._state.readyState === READY_STATE.CONNECTING) {
      this._state.readyState = READY_STATE.CLOSING
      if (this._state.retryTimer)
        clearTimeout(this._state.retryTimer)
      this._state.retryTimer = undefined
      this._state.onConnect.reject(
        new AMQPConnectionError('CLOSING', 'channel creation failed; connection is closing'))
      this._socket.destroy()
      return
    }

    this._state.readyState = READY_STATE.CLOSING
    this._checkEmpty()
    // wait for all channels to close
    await this._state.onEmpty.promise

    // might have transitioned to CLOSED while waiting for channels
    if (this._socket.writable) {
      this._writeMethod(0, 'connection.close', {replyCode: 200, classId: 0, methodId: 0})
      this._socket.end()
      await new Promise(resolve => this._socket.once('close', resolve))
    }
  }

  /** Immediately destroy the connection. All channels are closed. All pending
   * actions are rejected. */
  unsafeDestroy(): void {
    if (this._state.readyState === READY_STATE.CLOSED)
      return
    // CLOSING, CONNECTING, OPEN
    this._state.readyState = READY_STATE.CLOSING
    if (this._state.retryTimer)
      clearTimeout(this._state.retryTimer)
    this._state.retryTimer = undefined
    this._state.onConnect.reject(
      new AMQPConnectionError('CLOSING', 'channel creation failed; connection is closing'))
    this._socket.destroy()
  }

  /**
   * Create a message consumer that can recover from dropped connections.
   * This will create a dedicated Channel, declare a queue, declare exchanges,
   * declare bindings, establish QoS, and finally start consuming messages. If
   * the connection is reset, then all of this setup will re-run on a new
   * Channel. This uses the same retry-delay logic as the Connection.
   *
   * The handler is called for each incoming message. If it throws an error or
   * returns a rejected Promise then the message is rejected with "basic.nack"
   *
   * The 2nd argument of `handler(msg, reply)` can be used to reply to RPC
   * requests. e.g. `await reply('my-response-body')`. This acts like
   * basicPublish() except the message body comes first, and the routingKey is
   * automatically set.
   *
   * This is an EventEmitter that may emit errors. Also, since this wraps a
   * Channel, this must be closed before closing the Connection.
   *
   * ```
   * const consumer = rabbit.createConsumer({queue: 'my-queue'}, async (msg, reply) => {
   *   console.log(msg)
   *   // ... do some work ...
   *   // optionally reply to an RPC-type message
   *   await reply('my-response-data')
   * })
   *
   * // when closing the application
   * await consumer.close()
   * ```
   */
  createConsumer(props: ConsumerProps, handler: ConsumerHandler): Consumer {
    return new Consumer(this, props, handler)
  }

  /** Set up an anonymous pseudo-queue (fast reply) consumer/publisher to
   * perform Remote Procedure Calls (RPC). This will create a single "client"
   * Channel on which you may publish messages, and a consumer to listen for
   * responses. You will also need to create a "server" Channel to handle these
   * requests and publish responses. The response message should be published
   * with: `{routingKey: reqmsg.replyTo, correlationId: reqmsg.correlationId}`
   *
   * If you're using the createConsumer() helper, then you can reply to RPC
   * requests with the 2nd argument of the message handler.
   *
   * Also, since this wraps a Channel, this must be closed before closing the
   * Connection.
   *
   * See https://www.rabbitmq.com/direct-reply-to.html
   *
   * ```
   * const client = rabbit.createRPCClient({confirm: true})
   * const res = await client.publish({routingKey: 'my-rpc-queue'}, 'ping')
   * console.log(res)
   * await client.close()
   * ```
   * */
  createRPCClient(props?: RPCProps): RPCClient {
    return new RPCClient(this, props || {})
  }

  /**
   * Create a message publisher that can recover from dropped connections.
   * This will create a dedicated Channel, declare queues, declare exchanges,
   * and declare bindings. If the connection is reset, then all of this setup
   * will rerun on a new Channel.
   */
  createPublisher(props: PublisherProps = {}): Publisher {
    let _ch: Channel|undefined
    let pendingSetup: Promise<Channel>|undefined
    let isClosed = false
    const emitter = new EventEmitter()

    const setup = async () => {
      const ch = _ch = await this.acquire()
      ch.on('basic.return', (msg) => emitter.emit('basic.return', msg))
      if (props.queues) for (const params of props.queues) {
        await ch.queueDeclare(params)
      }
      if (props.exchanges) for (const params of props.exchanges) {
        await ch.exchangeDeclare(params)
      }
      if (props.queueBindings) for (const params of props.queueBindings) {
        await ch.queueBind(params)
      }
      if (props.exchangeBindings) for (const params of props.exchangeBindings) {
        await ch.exchangeBind(params)
      }
      if (props.confirm)
        await ch.confirmSelect()
      return ch
    }

    return Object.assign(emitter, {
      publish(envelope: Envelope, body: MessageBody) {
        if (isClosed)
          return Promise.reject(new AMQPChannelError('CLOSED', 'publisher is closed'))
        if (!_ch?.active) {
          if (!pendingSetup)
            pendingSetup = setup().finally(() =>{ pendingSetup = undefined })
          return pendingSetup.then(ch => ch.basicPublish(envelope, body))
        }
        return _ch.basicPublish(envelope, body)
      },
      close() {
        isClosed = true
        if (pendingSetup)
          return pendingSetup.then(ch => ch.close())
        return _ch ? _ch.close() : Promise.resolve()
      }
    })
  }

  /** @internal */
  private _connect(): Socket {
    this._state.retryTimer = undefined

    // get next host, round-robin
    const host = this._opt.hosts[this._state.hostIndex]
    this._state.hostIndex = (this._state.hostIndex + 1) % this._opt.hosts.length

    // assume any previously opened socket is already fully closed
    let socket: Socket
    if (this._opt.tls) {
      socket = tls.connect({
        port: host.port,
        host: host.hostname,
        ...this._opt.socket,
        ...this._opt.tls
      })
    } else {
      socket = net.connect({
        port: host.port,
        host: host.hostname,
        ...this._opt.socket
      })
    }
    this._socket = socket

    socket.setNoDelay(!!this._opt.noDelay)

    let connectionError: Error|undefined

    // create connection timeout
    if (this._opt.connectionTimeout > 0) {
      this._state.connectionTimer = setTimeout(() => {
        socket.destroy(new AMQPConnectionError('CONNECTION_TIMEOUT', 'connection timed out'))
      }, this._opt.connectionTimeout)
    }

    socket.on('timeout', () => {
      socket.destroy(new AMQPConnectionError('SOCKET_TIMEOUT', 'socket timed out'))
    })
    socket.on('error', err => {
      connectionError = connectionError || err
    })
    socket.on('close', () => {
      if (this._state.readyState === READY_STATE.CLOSING) {
        this._state.readyState = READY_STATE.CLOSED
        this._reset(connectionError || new AMQPConnectionError('CLOSING', 'connection is closed'))
      } else {
        connectionError = connectionError || new AMQPConnectionError('CONN_CLOSE',
          'socket closed unexpectedly by server')
        if (this._state.readyState === READY_STATE.OPEN)
          this._state.onConnect = createDeferred(true)
        this._state.readyState = READY_STATE.CONNECTING
        this._reset(connectionError)
        const retryCount = this._state.retryCount++
        const delay = expBackoff(this._opt.retryLow, this._opt.retryHigh, 0, retryCount)
        this._state.retryTimer = setTimeout(this._connect, delay)
        // emit & cede control to user only as final step
        // suppress spam during reconnect
        if (retryCount <= 1)
          this.emit('error', connectionError)
      }
    })

    const readerLoop = async () => {
      try {
        const read = createAsyncReader(socket)
        await this._negotiate(read)
        // consume AMQP DataFrames until the socket is closed
        while (true) this._handleChunk(await codec.decodeFrame(read))
      } catch (err) {
        // TODO if err instanceof AMQPConnectionError then invoke connection.close + socket.end() + socket.resume()
        // all bets are off when we get a codec error; just kill the socket
        if (err.code !== 'READ_END') socket.destroy(err)
      }
    }

    socket.write(codec.PROTOCOL_HEADER)
    readerLoop()

    return socket
  }

  /** @internal Establish connection parameters with the server. */
  private async _negotiate(read: (bytes: number) => Promise<Buffer>): Promise<void> {
    const readFrame = async (fullName: string) => {
      const frame = await codec.decodeFrame(read)
      if (frame.channelId === 0 && frame.type === 'method' && frame.fullName === fullName)
        return frame.params
      throw new AMQPConnectionError('COMMAND_INVALID', 'received unexpected frame during negotiation')
    }

    // check for version mismatch (only on first chunk)
    const chunk = await read(8)
    if (chunk.toString('utf-8', 0, 4) === 'AMQP') {
      const version = chunk.slice(4).join('-')
      const message = `this version of AMQP is not supported; the server suggests ${version}`
      throw new AMQPConnectionError('VERSION_MISMATCH', message)
    }
    this._socket.unshift(chunk)

    /*const serverParams = */await readFrame('connection.start')
    // TODO support EXTERNAL mechanism, i.e. x509 peer verification
    // https://github.com/rabbitmq/rabbitmq-auth-mechanism-ssl
    // serverParams.mechanisms === 'EXTERNAL PLAIN AMQPLAIN'
    this._writeMethod(0, 'connection.start-ok', {
      locale: 'en_US',
      mechanism: 'PLAIN',
      response: [null, this._opt.username, this._opt.password].join(String.fromCharCode(0)),
      clientProperties: this._opt.connectionName
        ? {...CLIENT_PROPERTIES, connection_name: this._opt.connectionName}
        : CLIENT_PROPERTIES
    })
    const params = await readFrame('connection.tune')
    const channelMax = params.channelMax > 0
      ? Math.min(this._opt.maxChannels, params.channelMax)
      : this._opt.maxChannels
    this._state.channelMax = channelMax
    const frameMax = params.frameMax > 0
      ? Math.min(this._opt.frameMax, params.frameMax)
      : this._opt.frameMax
    this._state.frameMax = frameMax
    const heartbeat = determineHeartbeat(params.heartbeat, this._opt.heartbeat)
    this._writeMethod(0, 'connection.tune-ok', {channelMax, frameMax, heartbeat})
    this._writeMethod(0, 'connection.open', {virtualHost: this._opt.vhost})
    await readFrame('connection.open-ok')

    // create heartbeat timeout, or disable when 0
    this._socket.setTimeout(heartbeat * 1250)

    this._state.readyState = READY_STATE.OPEN
    this._state.retryCount = 1
    this._state.onConnect.resolve()
    if (this._state.connectionTimer)
      clearTimeout(this._state.connectionTimer)
    this._state.connectionTimer = undefined
    this.emit('connection')
  }

  /** @internal */
  _writeMethod<T extends keyof MethodParams>(channelId: number, fullName: T, params: MethodParams[T]): void {
    const frame = codec.encodeFrame({type: 'method', channelId, fullName, params})
    this._socket.write(frame)
  }

  /** @internal */
  private _handleChunk(evt: DataFrame): void {
    let ch: Channel|undefined
    if (evt) {
      if (evt.type === 'heartbeat') {
        // if connection.blocked then heartbeat monitoring is disabled; don't respond
        if (!this._socket.writableCorked) this._socket.write(codec.HEARTBEAT_FRAME)
      } else if (evt.type === 'method') {
        switch (evt.fullName) {
          case 'connection.close':
            if (this._socket.writable) {
              this._writeMethod(0, 'connection.close-ok', undefined)
              this._socket.end()
              this._socket.uncork()
            }
            this._socket.emit('error', new AMQPConnectionError(evt.params))
            break
          case 'connection.close-ok':
            // just wait for the socket to fully close
            break
          case 'connection.blocked':
            this._socket.cork()
            this.emit('connection.blocked', evt.params.reason)
            break
          case 'connection.unblocked':
            this._socket.uncork()
            this.emit('connection.unblocked')
            break
          default:
            ch = this._state.leased.get(evt.channelId)
            if (ch == null) {
              // TODO test me
              throw new AMQPConnectionError('UNEXPECTED_FRAME',
                'client received a method frame for an unexpected channel')
            }
            ch._onMethod(evt)
        }
      } else if (evt.type === 'header') {
        const ch = this._state.leased.get(evt.channelId)
        if (ch == null) {
          // TODO test me
          throw new AMQPConnectionError('UNEXPECTED_FRAME',
            'client received a header frame for an unexpected channel')
        }
        ch._onHeader(evt)
      } else if (evt.type === 'body') {
        const ch = this._state.leased.get(evt.channelId)
        if (ch == null) {
          // TODO test me
          throw new AMQPConnectionError('UNEXPECTED_FRAME',
            'client received a body frame for an unexpected channel')
        }
        ch._onBody(evt)
      }
    }
  }

  /** @internal */
  private _reset(err: Error): void {
    for (let ch of this._state.leased.values())
      ch._clear(err)
    this._state.leased.clear()
    this._checkEmpty()
    if (this._state.connectionTimer)
      clearTimeout(this._state.connectionTimer)
    this._state.connectionTimer = undefined
  }

  /** @internal */
  _checkEmpty(): void {
    if (!this._state.leased.size && this._state.readyState === READY_STATE.CLOSING)
      this._state.onEmpty.resolve()
  }
}

function determineHeartbeat(x: number, y: number): number {
  if (x && y) return Math.min(x, y)
  // according to the AMQP spec, BOTH the client and server must set heartbeat to 0
  if (!x && !y) return 0
  // otherwise the higher number is used
  return Math.max(x, y)
}

export default Connection
