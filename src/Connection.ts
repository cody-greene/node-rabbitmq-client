import net, {Socket} from 'node:net'
import tls from 'node:tls'
import EventEmitter from 'node:events'
import {AMQPConnectionError, AMQPChannelError, AMQPError} from './exception'
import {READY_STATE, createAsyncReader, expBackoff, createDeferred, Deferred, recaptureAndThrow} from './util'
import {
  Cmd,
  DataFrame,
  FrameType,
  HEARTBEAT_FRAME,
  MethodFrame,
  MethodParams,
  PROTOCOL_HEADER,
  decodeFrame,
  encodeFrame,
  Envelope,
  MessageBody,
  ReturnedMessage,
  ReplyCode,
  SyncMessage
} from './codec'
import {Channel} from './Channel'
import normalizeOptions, {ConnectionOptions} from './normalize'
import SortedMap from './SortedMap'
import {Consumer, ConsumerProps, ConsumerHandler} from './Consumer'
import {RPCClient, RPCProps} from './RPCClient'

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

const CLIENT_PROPERTIES = {
  product: 'rabbitmq-client',
  version: '4.5.3',
  platform: `node.js-${process.version}`,
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
}

export declare interface Connection {
  /** The connection is successfully (re)established */
  on(name: 'connection', cb: () => void): this;
  /** The rabbitmq server is low on resources. Message publishers should pause.
   * The outbound side of the TCP socket is blocked until
   * "connection.unblocked" is received, meaning messages will be held in
   * memory.
   * {@link https://www.rabbitmq.com/connection-blocked.html}
   * {@label BLOCKED} */
  on(name: 'connection.blocked', cb: (reason: string) => void): this;
  /** The rabbitmq server is accepting new messages. */
  on(name: 'connection.unblocked', cb: () => void): this;
  on(name: 'error', cb: (err: any) => void): this;
}

/**
 * This represents a single connection to a RabbitMQ server (or cluster). Once
 * created, it will immediately attempt to establish a connection. When the
 * connection is lost, for whatever reason, it will reconnect. This implements
 * the EventEmitter interface and may emit `error` events. Close it with
 * {@link Connection#close | Connection#close()}
 *
 * @example
 * ```
 * const rabbit = new Connection('amqp://guest:guest@localhost:5672')
 * rabbit.on('error', (err) => {
 *   console.log('RabbitMQ connection error', err)
 * })
 * rabbit.on('connection', () => {
 *   console.log('RabbitMQ (re)connected')
 * })
 * process.on('SIGINT', () => {
 *   rabbit.close()
 * })
 * ```
 */
export class Connection extends EventEmitter {
  /** @internal */
  _opt: ReturnType<typeof normalizeOptions>
  /** @internal */
  _socket: Socket

  /** @internal */
  _state: {
    channelMax: number,
    frameMax: number,
    heartbeatTimer?: NodeJS.Timer,
    /** Received data since last heartbeat */
    hasRead?: boolean,
    /** Sent data since last heartbeat */
    hasWrite?: boolean,
    hostIndex: number,
    lazyChannel?: Channel|Promise<Channel>,
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
      await raceWithTimeout(
        this._state.onConnect.promise,
        this._opt.acquireTimeout,
        'channel aquisition timed out'
      ).catch(recaptureAndThrow)
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
    ch.once('close', () => {
      this._state.leased.delete(id)
      this._checkEmpty()
    })
    await ch._invoke(Cmd.ChannelOpen, Cmd.ChannelOpenOK, {rsvp1: ''})
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
    if (this._state.lazyChannel instanceof Promise) {
      this._state.lazyChannel.then(ch => ch.close())
    } else if (this._state.lazyChannel) {
      this._state.lazyChannel.close()
    }
    this._checkEmpty()
    // wait for all channels to close
    await this._state.onEmpty.promise

    clearInterval(this._state.heartbeatTimer)
    this._state.heartbeatTimer = undefined

    // might have transitioned to CLOSED while waiting for channels
    if (this._socket.writable) {
      this._writeMethod({
        type: FrameType.METHOD,
        channelId: 0,
        methodId: Cmd.ConnectionClose,
        params: {replyCode: 200, methodId: 0, replyText: ''}})
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

  /** Create a message consumer that can recover from dropped connections.
   * @param cb Process an incoming message. */
  createConsumer(props: ConsumerProps, cb: ConsumerHandler): Consumer {
    return new Consumer(this, props, cb)
  }

  /** This will create a single "client" `Channel` on which you may publish
   * messages and listen for direct responses. This can allow, for example, two
   * micro-services to communicate with each other using RabbitMQ as the
   * middleman instead of directly via HTTP. */
  createRPCClient(props?: RPCProps): RPCClient {
    return new RPCClient(this, props || {})
  }

  /**
   * Create a message publisher that can recover from dropped connections.
   * This will create a dedicated Channel, declare queues, declare exchanges,
   * and declare bindings. If the connection is reset, then all of this setup
   * will rerun on a new Channel. This also supports retries.
   */
  createPublisher(props: PublisherProps = {}): Publisher {
    let _ch: Channel|undefined
    let pendingSetup: Promise<Channel>|undefined
    let isClosed = false
    let maxAttempts = props.maxAttempts || 1
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

    const send = async (envelope: string|Envelope, body: MessageBody) => {
      let attempts = 0
      while (true) try {
        if (isClosed)
          throw new AMQPChannelError('CLOSED', 'publisher is closed')
        if (!_ch?.active) {
          if (!pendingSetup)
            pendingSetup = setup().finally(() =>{ pendingSetup = undefined })
          _ch = await pendingSetup
        }
        return await _ch.basicPublish(envelope, body)
      } catch (err) {
        Error.captureStackTrace(err) // original async trace is likely not useful to users
        if (++attempts >= maxAttempts) {
          throw err
        } else { // notify & loop
          emitter.emit('retry', err, envelope, body)
        }
      }
    }

    return Object.assign(emitter, {
      publish: send,
      send: send,
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
        const delay = expBackoff(this._opt.retryLow, this._opt.retryHigh, retryCount)
        this._state.retryTimer = setTimeout(this._connect, delay)
        // emit & cede control to user only as final step
        // suppress spam during reconnect
        if (retryCount <= 1)
          this.emit('error', connectionError)
      }
    })

    const ogwrite = socket.write
    socket.write = (...args) => {
      this._state.hasWrite = true
      return ogwrite.apply(socket, args as any)
    }

    const readerLoop = async () => {
      try {
        const read = createAsyncReader(socket)
        await this._negotiate(read)
        // consume AMQP DataFrames until the socket is closed
        while (true) this._handleChunk(await decodeFrame(read))
      } catch (err) {
        // TODO if err instanceof AMQPConnectionError then invoke connection.close + socket.end() + socket.resume()
        // all bets are off when we get a codec error; just kill the socket
        if (err.code !== 'READ_END') socket.destroy(err)
      }
    }

    socket.write(PROTOCOL_HEADER)
    readerLoop()

    return socket
  }

  /** @internal Establish connection parameters with the server. */
  private async _negotiate(read: (bytes: number) => Promise<Buffer>): Promise<void> {
    const readFrame = async <T extends Cmd>(methodId: T): Promise<MethodParams[T]> => {
      const frame = await decodeFrame(read)
      if (frame.channelId === 0 && frame.type === FrameType.METHOD && frame.methodId === methodId)
        return frame.params as MethodParams[T]
      if (frame.type === FrameType.METHOD && frame.methodId === Cmd.ConnectionClose) {
        const strcode = ReplyCode[frame.params.replyCode] || String(frame.params.replyCode)
        const msg = Cmd[frame.params.methodId] + ': ' + frame.params.replyText
        throw new AMQPConnectionError(strcode, msg)
      }
      throw new AMQPConnectionError('COMMAND_INVALID',
        'received unexpected frame during negotiation: ' + JSON.stringify(frame))
    }

    // check for version mismatch (only on first chunk)
    const chunk = await read(8)
    if (chunk.toString('utf-8', 0, 4) === 'AMQP') {
      const version = chunk.slice(4).join('-')
      const message = `this version of AMQP is not supported; the server suggests ${version}`
      throw new AMQPConnectionError('VERSION_MISMATCH', message)
    }
    this._socket.unshift(chunk)

    /*const serverParams = */await readFrame(Cmd.ConnectionStart)
    // TODO support EXTERNAL mechanism, i.e. x509 peer verification
    // https://github.com/rabbitmq/rabbitmq-auth-mechanism-ssl
    // serverParams.mechanisms === 'EXTERNAL PLAIN AMQPLAIN'
    this._writeMethod({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionStartOK,
      params: {
        locale: 'en_US',
        mechanism: 'PLAIN',
        response: [null, this._opt.username, this._opt.password].join(String.fromCharCode(0)),
        clientProperties: this._opt.connectionName
          ? {...CLIENT_PROPERTIES, connection_name: this._opt.connectionName}
          : CLIENT_PROPERTIES
      }})
    const params = await readFrame(Cmd.ConnectionTune)
    const channelMax = params.channelMax > 0
      ? Math.min(this._opt.maxChannels, params.channelMax)
      : this._opt.maxChannels
    this._state.channelMax = channelMax
    const frameMax = params.frameMax > 0
      ? Math.min(this._opt.frameMax, params.frameMax)
      : this._opt.frameMax
    this._state.frameMax = frameMax
    const heartbeat = determineHeartbeat(params.heartbeat, this._opt.heartbeat)
    this._writeMethod({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionTuneOK,
      params: {channelMax, frameMax, heartbeat}})
    this._writeMethod({
      type: FrameType.METHOD,
      channelId: 0,
      methodId: Cmd.ConnectionOpen,
      params: {virtualHost: this._opt.vhost || '/', rsvp1: ''}})
    await readFrame(Cmd.ConnectionOpenOK)

    // create heartbeat timeout, or disable when 0
    if (heartbeat > 0) {
      let miss = 0
      this._state.hasWrite = this._state.hasRead = false
      this._state.heartbeatTimer = setInterval(() => {
        if (!this._state.hasRead) {
          if (++miss >= 4)
            this._socket.destroy(new AMQPConnectionError('SOCKET_TIMEOUT', 'socket timed out (no heartbeat)'))
        } else {
          this._state.hasRead = false
          miss = 0
        }
        if (!this._state.hasWrite) {
          // if connection.blocked then heartbeat monitoring is disabled
          if (this._socket.writable && !this._socket.writableCorked)
            this._socket.write(HEARTBEAT_FRAME)
        }
        this._state.hasWrite = false
      }, Math.ceil(heartbeat * 1000 / 2))
    }

    this._state.readyState = READY_STATE.OPEN
    this._state.retryCount = 1
    this._state.onConnect.resolve()
    if (this._state.connectionTimer)
      clearTimeout(this._state.connectionTimer)
    this._state.connectionTimer = undefined
    this.emit('connection')
  }

  /** @internal */
  _writeMethod(params: MethodFrame): void {
    const frame = encodeFrame(params, this._state.frameMax)
    this._socket.write(frame)
  }

  /** @internal */
  private _handleChunk(frame: DataFrame): void {
    this._state.hasRead = true
    let ch: Channel|undefined
    if (frame) {
      if (frame.type === FrameType.HEARTBEAT) {
        // still alive
      } else if (frame.type === FrameType.METHOD) {
        switch (frame.methodId) {
          case Cmd.ConnectionClose:
            if (this._socket.writable) {
              this._writeMethod({
                type: FrameType.METHOD,
                channelId: 0,
                methodId: Cmd.ConnectionCloseOK,
                params: undefined
              })
              this._socket.end()
              this._socket.uncork()
            }
            const strcode = ReplyCode[frame.params.replyCode] || String(frame.params.replyCode)
            const souceMethod = frame.params.methodId ? Cmd[frame.params.methodId] + ': ' : ''
            const msg = souceMethod + frame.params.replyText
            this._socket.emit('error', new AMQPConnectionError(strcode, msg))
            break
          case Cmd.ConnectionCloseOK:
            // just wait for the socket to fully close
            break
          case Cmd.ConnectionBlocked:
            this._socket.cork()
            this.emit('connection.blocked', frame.params.reason)
            break
          case Cmd.ConnectionUnblocked:
            this._socket.uncork()
            this.emit('connection.unblocked')
            break
          default:
            ch = this._state.leased.get(frame.channelId)
            if (ch == null) {
              // TODO test me
              throw new AMQPConnectionError('UNEXPECTED_FRAME',
                'client received a method frame for an unexpected channel')
            }
            ch._onMethod(frame)
        }
      } else if (frame.type === FrameType.HEADER) {
        const ch = this._state.leased.get(frame.channelId)
        if (ch == null) {
          // TODO test me
          throw new AMQPConnectionError('UNEXPECTED_FRAME',
            'client received a header frame for an unexpected channel')
        }
        ch._onHeader(frame)
      } else if (frame.type === FrameType.BODY) {
        const ch = this._state.leased.get(frame.channelId)
        if (ch == null) {
          // TODO test me
          throw new AMQPConnectionError('UNEXPECTED_FRAME',
            'client received a body frame for an unexpected channel')
        }
        ch._onBody(frame)
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
    clearInterval(this._state.heartbeatTimer)
    this._state.heartbeatTimer = undefined
  }

  /** @internal */
  _checkEmpty(): void {
    if (!this._state.leased.size && this._state.readyState === READY_STATE.CLOSING)
      this._state.onEmpty.resolve()
  }

  /** @internal */
  async _lazy(): Promise<Channel> {
    let ch = this._state.lazyChannel
    if (ch instanceof Promise) {
      return ch
    }
    if (ch == null || !ch.active) {
      return this._state.lazyChannel = await (this._state.lazyChannel = this.acquire())
    }
    return ch
  }

  /** {@inheritDoc Channel#basicGet} */
  basicGet(params: MethodParams[Cmd.BasicGet]): Promise<undefined|SyncMessage>
  basicGet(queue?: string): Promise<undefined|SyncMessage>
  /** @ignore */
  basicGet(params?: string|MethodParams[Cmd.BasicGet]): Promise<undefined|SyncMessage>
  basicGet(params?: string|MethodParams[Cmd.BasicGet]): Promise<undefined|SyncMessage> {
    return this._lazy().then(ch => ch.basicGet(params))
  }

  /** {@inheritDoc Channel#queueDeclare} */
  queueDeclare(params: MethodParams[Cmd.QueueDeclare]): Promise<MethodParams[Cmd.QueueDeclareOK]>
  queueDeclare(queue?: string): Promise<MethodParams[Cmd.QueueDeclareOK]>
  /** @ignore */
  queueDeclare(params?: string|MethodParams[Cmd.QueueDeclare]): Promise<MethodParams[Cmd.QueueDeclareOK]>
  queueDeclare(params?: string|MethodParams[Cmd.QueueDeclare]): Promise<MethodParams[Cmd.QueueDeclareOK]> {
    return this._lazy().then(ch => ch.queueDeclare(params))
  }

  /** {@inheritDoc Channel#exchangeBind} */
  exchangeBind(params: MethodParams[Cmd.ExchangeBind]): Promise<void> {
    return this._lazy().then(ch => ch.exchangeBind(params))
  }

  /** {@inheritDoc Channel#exchangeDeclare} */
  exchangeDeclare(params: MethodParams[Cmd.ExchangeDeclare]): Promise<void> {
    return this._lazy().then(ch => ch.exchangeDeclare(params))
  }

  /** {@inheritDoc Channel#exchangeDelete} */
  exchangeDelete(params: MethodParams[Cmd.ExchangeDelete]): Promise<void> {
    return this._lazy().then(ch => ch.exchangeDelete(params))
  }

  /** {@inheritDoc Channel#exchangeUnbind} */
  exchangeUnbind(params: MethodParams[Cmd.ExchangeUnbind]): Promise<void> {
    return this._lazy().then(ch => ch.exchangeUnbind(params))
  }

  /** {@inheritDoc Channel#queueBind} */
  queueBind(params: MethodParams[Cmd.QueueBind]): Promise<void> {
    return this._lazy().then(ch => ch.queueBind(params))
  }

  /** {@inheritDoc Channel#queueDelete} */
  queueDelete(params: MethodParams[Cmd.QueueDelete]): Promise<MethodParams[Cmd.QueueDeleteOK]>
  queueDelete(queue?: string): Promise<MethodParams[Cmd.QueueDeleteOK]>
  /** @ignore */
  queueDelete(params?: string|MethodParams[Cmd.QueueDelete]): Promise<MethodParams[Cmd.QueueDeleteOK]>
  queueDelete(params?: string|MethodParams[Cmd.QueueDelete]): Promise<MethodParams[Cmd.QueueDeleteOK]> {
    return this._lazy().then(ch => ch.queueDelete(params))
  }

  /** {@inheritDoc Channel#queuePurge} */
  queuePurge(queue?: string): Promise<MethodParams[Cmd.QueuePurgeOK]>
  queuePurge(params: MethodParams[Cmd.QueuePurge]): Promise<MethodParams[Cmd.QueuePurgeOK]>
  /** @ignore */
  queuePurge(params?: string|MethodParams[Cmd.QueuePurge]): Promise<MethodParams[Cmd.QueuePurgeOK]>
  queuePurge(params?: string|MethodParams[Cmd.QueuePurge]): Promise<MethodParams[Cmd.QueuePurgeOK]> {
    return this._lazy().then(ch => ch.queuePurge(params))
  }

  /** {@inheritDoc Channel#queueUnbind} */
  queueUnbind(params: MethodParams[Cmd.QueueUnbind]): Promise<void> {
    return this._lazy().then(ch => ch.queueUnbind(params))
  }

  /** True if the connection is established and unblocked. See also {@link Connection#on:BLOCKED | Connection#on('connection.blocked')}) */
  get ready(): boolean {
    return this._state.readyState === READY_STATE.OPEN && !this._socket.writableCorked
  }
}

function determineHeartbeat(x: number, y: number): number {
  if (x && y) return Math.min(x, y)
  // according to the AMQP spec, BOTH the client and server must set heartbeat to 0
  if (!x && !y) return 0
  // otherwise the higher number is used
  return Math.max(x, y)
}

export interface PublisherProps {
  /** Enable publish-confirm mode. See {@link Channel#confirmSelect} */
  confirm?: boolean,
  /** Maximum publish attempts. Retries are disabled by default.
   * Increase this number to retry when a publish fails. The Connection options
   * acquireTimeout, retryLow, and retryHigh will affect time between retries.
   * Each failed attempt will also emit a "retry" event.
   * @default 1
   * */
  maxAttempts?: number,
  /** see {@link Channel.on}('basic.return') */
  onReturn?: (msg: ReturnedMessage) => void,
  /**
   * Define any queues to be declared before the first publish and whenever
   * the connection is reset. Same as {@link Channel#queueDeclare | Channel#queueDeclare()}
   */
  queues?: Array<MethodParams[Cmd.QueueDeclare]>
  /**
   * Define any exchanges to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel#exchangeDeclare | Channel#exchangeDeclare()}
   */
  exchanges?: Array<MethodParams[Cmd.ExchangeDeclare]>
  /**
   * Define any queue-exchange bindings to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel#queueBind | Channel#queueBind()}
   */
  queueBindings?: Array<MethodParams[Cmd.QueueBind]>
  /**
   * Define any exchange-exchange bindings to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel#exchangeBind | Channel#exchangeBind()}
   */
  exchangeBindings?: Array<MethodParams[Cmd.ExchangeBind]>
}

/**
 * @see {@link Connection#createPublisher | Connection#createPublisher()}
 *
 * The underlying Channel is lazily created the first time a message is
 * published.
 *
 * @example
 * ```
 * const pub = rabbit.createPublisher({
 *   confirm: true,
 *   exchanges: [{exchange: 'user', type: 'topic'}]
 * })
 *
 * await pub.send({exchange: 'user', routingKey: 'user.create'}, userInfo)
 *
 * await pub.close()
 * ```
 */
export interface Publisher extends EventEmitter {
  /** @deprecated Alias for {@link Publisher#send} */
  publish(envelope: string|Envelope, body: MessageBody): Promise<void>;
  /** {@inheritDoc Channel#basicPublish} */
  send(envelope: Envelope, body: MessageBody): Promise<void>;
  /** Send directly to a queue. Same as `send({routingKey: queue}, body)` */
  send(queue: string, body: MessageBody): Promise<void>;
  /** @ignore */
  send(envelope: string|Envelope, body: MessageBody): Promise<void>;
  /** {@inheritDoc Channel#on:BASIC_RETURN} */
  on(name: 'basic.return', cb: (msg: ReturnedMessage) => void): this;
  /** See maxAttempts. Emitted each time a failed publish will be retried. */
  on(name: 'retry', cb: (err: any, envelope: Envelope, body: MessageBody) => void): this;
  /** Close the underlying channel */
  close(): Promise<void>;
}
