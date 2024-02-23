import {AMQPError, AMQPChannelError, AMQPConnectionError} from './exception'
import {createDeferred, Deferred, EncoderStream, recaptureAndThrow} from './util'
import type {Connection} from './Connection'
import EventEmitter from 'node:events'
import {
  AsyncMessage,
  BodyFrame,
  Cmd,
  Envelope,
  FrameType,
  HeaderFrame,
  MessageBody,
  MethodFrame,
  MethodParams,
  ReplyCode,
  ReturnedMessage,
  SyncMessage,
  genContentFrames,
  genFrame,
} from './codec'

enum CH_MODE {NORMAL, TRANSACTION, CONFIRM}

/**
 * AMQP messages consist of a MethodFrame followed by a HeaderFrame and a
 * number of BodyFrames. The body is chunked, limited by a max-frame-size
 * negotiated with the server.
 */
interface AMQPMessage {
  methodFrame?: MethodFrame,
  headerFrame?: HeaderFrame,
  /** Count of BodyFrames received */
  received: number,
  chunks?: Buffer[]
}

export declare interface Channel {
  /** The specified consumer was stopped by the server. The error param
   * describes the reason for the cancellation. */
  on(name: 'basic.cancel', cb: (consumerTag: string, err: any) => void): this;
  /** An undeliverable message was published with the "immediate" flag set, or
   * an unroutable message published with the "mandatory" flag set. The reply
   * code and text provide information about the reason that the message was
   * undeliverable.
   * {@label BASIC_RETURN} */
  on(name: 'basic.return', cb: (msg: ReturnedMessage) => void): this;
  /** The channel was closed, because you closed it, or due to some error */
  on(name: 'close', cb: () => void): this;
}

/**
 * @see {@link Connection#acquire | Connection#acquire()}
 * @see {@link Connection#createConsumer | Connection#createConsumer()}
 * @see {@link Connection#createPublisher | Connection#createPublisher()}
 * @see {@link Connection#createRPCClient | Connection#createRPCClient()}
 *
 * A raw Channel can be acquired from your Connection, but please consider
 * using a higher level abstraction like a {@link Consumer} or
 * {@link Publisher} for most cases.
 *
 * AMQP is a multi-channelled protocol. Channels provide a way to multiplex a
 * heavyweight TCP/IP connection into several light weight connections. This
 * makes the protocol more “firewall friendly” since port usage is predictable.
 * It also means that traffic shaping and other network QoS features can be
 * easily employed. Channels are independent of each other and can perform
 * different functions simultaneously with other channels, the available
 * bandwidth being shared between the concurrent activities.
 *
 * @example
 * ```
 * const rabbit = new Connection()
 *
 * // Will wait for the connection to establish and then create a Channel
 * const ch = await rabbit.acquire()
 *
 * // Channels can emit some events too (see documentation)
 * ch.on('close', () => {
 *   console.log('channel was closed')
 * })
 *
 * // Create a queue for the duration of this connection
 * await ch.queueDeclare({queue: 'my-queue'})
 *
 * // Enable publisher acknowledgements
 * await ch.confirmSelect()
 *
 * const data = {title: 'just some object'}
 *
 * // Resolves when the data has been flushed through the socket or if
 * // ch.confirmSelect() was called: will wait for an acknowledgement
 * await ch.basicPublish({routingKey: 'my-queue'}, data)
 *
 * const msg = ch.basicGet('my-queue')
 * console.log(msg)
 *
 * await ch.queueDelete('my-queue')
 *
 * // It's your responsibility to close any acquired channels
 * await ch.close()
 * ```
 */
export class Channel extends EventEmitter {
  /** @internal */
  private _conn: Connection
  readonly id: number

  /** False if the channel is closed */
  active: boolean

  /** @internal */
  private _state: {
    unconfirmed: Map<number, Deferred<void>>
    mode: CH_MODE
    maxFrameSize: number
    rpc?: [dfd: Deferred<any>, req: Cmd, res: Cmd]
    rpcBuffer: Array<readonly [dfd: Deferred<any>, req: Cmd, res: Cmd, it: Generator<Buffer, void>]>
    cleared: boolean,
    /** For tracking consumers created with basic.consume */
    consumers: Map<string, (msg: AsyncMessage) => void>
    incoming?: AMQPMessage
    deliveryCount: number
    /**
     * Ensures a channel can only publish one message at a time.
     * Multiple channels may interleave their DataFrames, but for any given channel
     * the header/body frames MUST follow a basic.publish
     */
    stream: EncoderStream<Buffer>
  }

  /** @internal */
  constructor(id: number, conn: Connection) {
    super()
    this._conn = conn
    this.id = id
    this.active = true
    this._state = {
      maxFrameSize: conn._opt.frameMax,
      deliveryCount: 1,
      mode: CH_MODE.NORMAL,
      unconfirmed: new Map(),
      rpcBuffer: [],
      cleared: false,
      consumers: new Map(),
      stream: new EncoderStream(conn._socket)
    }
    this._state.stream.on('error', () => {
      // don't need to propagate error here:
      // - if connection ended: already handled by the Connection class
      // - if encoding error: error recieved by write callback
      this.close()
    })
  }

  /** Close the channel */
  async close() {
    if (!this.active) {
      return
    }
    this.active = false
    try {
      // wait for encoder stream to end
      if (this._state.stream.writable) {
        if (!this._state.rpc)
          this._state.stream.end()
        await new Promise(resolve => this._state.stream.on('close', resolve))
      } else {
        // if an rpc failed to encode then wait for it to clear
        await new Promise(setImmediate)
      }
      // wait for final rpc, if it was already sent
      if (this._state.rpc) {
        const [dfd] = this._state.rpc
        this._state.rpc = undefined
        await dfd.promise
      }
      // send channel.close
      const dfd = createDeferred()
      this._state.rpc = [dfd, Cmd.ChannelClose, Cmd.ChannelCloseOK]
      this._conn._writeMethod({
        type: FrameType.METHOD,
        channelId: this.id,
        methodId: Cmd.ChannelClose,
        params: {replyCode: 200, replyText: '', methodId: 0}})
      await dfd.promise
    } catch (err) {
      // ignored; if write fails because the connection closed then this is
      // technically a success. Can't have a channel without a connection!
    } finally {
      this._clear()
    }
  }

  /** @internal */
  _handleRPC(methodId: Cmd, data: any) {
    if (methodId === Cmd.ChannelClose) {
      const params: MethodParams[Cmd.ChannelClose] = data
      this.active = false
      this._conn._writeMethod({
        type: FrameType.METHOD,
        channelId: this.id,
        methodId: Cmd.ChannelCloseOK,
        params: undefined})
      const strcode = ReplyCode[params.replyCode] || String(params.replyCode)
      const msg = Cmd[params.methodId] + ': ' + params.replyText
      const err = new AMQPChannelError(strcode, msg)
      //const badName = SPEC.getFullName(params.classId, params.methodId)
      if (params.methodId === Cmd.BasicPublish && this._state.unconfirmed.size > 0) {
        // reject first unconfirmed message
        const [tag, dfd] = this._state.unconfirmed.entries().next().value
        this._state.unconfirmed.delete(tag)
        dfd.reject(err)
      } else if (this._state.rpc && params.methodId === this._state.rpc[1]) {
        // or reject the rpc
        const [dfd] = this._state.rpc
        this._state.rpc = undefined
        dfd.reject(err)
      } else {
        // last resort
        this._conn.emit('error', err)
      }
      this._clear()
      return
    }
    if (!this._state.rpc) {
      throw new AMQPConnectionError('UNEXPECTED_FRAME',
        `client received unexpected method ch${this.id}:${Cmd[methodId]} ${JSON.stringify(data)}`)
    }
    const [dfd, , expectedId] = this._state.rpc
    this._state.rpc = undefined
    if (expectedId !== methodId) {
      throw new AMQPConnectionError('UNEXPECTED_FRAME',
        `client received unexpected method ch${this.id}:${Cmd[methodId]} ${JSON.stringify(data)}`)
    }
    dfd.resolve(data)
    if (this._state.stream.writable) {
      if (!this.active)
        this._state.stream.end()
      else if (this._state.rpcBuffer.length > 0)
        this._rpcNext(this._state.rpcBuffer.shift()!)
    }
  }

  /**
   * Invoke all pending response handlers with an error
   * @internal
   */
  _clear(err?: Error) {
    if (this._state.cleared)
      return
    this._state.cleared = true
    if (err == null)
      err = new AMQPChannelError('CH_CLOSE', 'channel is closed')
    this.active = false
    if (this._state.rpc) {
      const [dfd] = this._state.rpc
      this._state.rpc = undefined
      dfd.reject(err)
    }
    for (const [dfd] of this._state.rpcBuffer) {
      dfd.reject(err)
    }
    this._state.rpcBuffer = []
    for (const dfd of this._state.unconfirmed.values()) {
      dfd.reject(err)
    }
    this._state.unconfirmed.clear()
    this._state.consumers.clear()
    this._state.stream.destroy(err)
    this.emit('close')
  }

  /** @internal */
  _onMethod(methodFrame: MethodFrame): void {
    if (this._state.incoming != null) {
      throw new AMQPConnectionError('UNEXPECTED_FRAME',
        'unexpected method frame, already awaiting header/body; this is a bug')
    }
    if ([Cmd.BasicDeliver, Cmd.BasicReturn, Cmd.BasicGetOK].includes(methodFrame.methodId)) {
      this._state.incoming = {methodFrame, headerFrame: undefined, chunks: undefined, received: 0}
    } else if (methodFrame.methodId === Cmd.BasicGetEmpty) {
      this._handleRPC(Cmd.BasicGetOK, undefined)
    } else if (this._state.mode === CH_MODE.CONFIRM && methodFrame.methodId === Cmd.BasicAck) {
      const params = methodFrame.params as Required<MethodParams[Cmd.BasicAck]>
      if (params.multiple) {
        for (const [tag, dfd] of this._state.unconfirmed.entries()) {
          if (tag > params.deliveryTag)
            break
          dfd.resolve()
          this._state.unconfirmed.delete(tag)
        }
      } else {
        const dfd = this._state.unconfirmed.get(params.deliveryTag)
        if (dfd) {
          dfd.resolve()
          this._state.unconfirmed.delete(params.deliveryTag)
        } else {
          //TODO channel error; PRECONDITION_FAILED, unexpected ack
        }
      }
    } else if (this._state.mode === CH_MODE.CONFIRM && methodFrame.methodId === Cmd.BasicNack) {
      const params = methodFrame.params as Required<MethodParams[Cmd.BasicNack]>
      if (params.multiple) {
        for (const [tag, dfd] of this._state.unconfirmed.entries()) {
          if (tag > params.deliveryTag)
            break
          dfd.reject(new AMQPError('NACK', 'message rejected by server'))
          this._state.unconfirmed.delete(tag)
        }
      } else {
        const dfd = this._state.unconfirmed.get(params.deliveryTag)
        if (dfd) {
          dfd.reject(new AMQPError('NACK', 'message rejected by server'))
          this._state.unconfirmed.delete(params.deliveryTag)
        } else {
          //TODO channel error; PRECONDITION_FAILED, unexpected nack
        }
      }
    } else if (methodFrame.methodId === Cmd.BasicCancel) {
      const params = methodFrame.params as Required<MethodParams[Cmd.BasicCancel]>
      this._state.consumers.delete(params.consumerTag)
      setImmediate(() => {
        this.emit('basic.cancel', params.consumerTag, new AMQPError('CANCEL_FORCED', 'cancelled by server'))
      })
    //} else if (methodFrame.fullName === 'channel.flow') unsupported; https://blog.rabbitmq.com/posts/2014/04/breaking-things-with-rabbitmq-3-3
    } else {
      this._handleRPC(methodFrame.methodId, methodFrame.params)
    }
  }

  /** @internal */
  _onHeader(headerFrame: HeaderFrame): void {
    if (!this._state.incoming || this._state.incoming.headerFrame || this._state.incoming.received > 0)
      throw new AMQPConnectionError('UNEXPECTED_FRAME', 'unexpected header frame; this is a bug')
    const expectedContentFrameCount = Math.ceil(headerFrame.bodySize / (this._state.maxFrameSize - 8))
    this._state.incoming.headerFrame = headerFrame
    this._state.incoming.chunks = new Array(expectedContentFrameCount)
    if (expectedContentFrameCount === 0)
      this._onBody()
  }

  /** @internal */
  _onBody(bodyFrame?: BodyFrame): void {
    if (this._state.incoming?.chunks == null || this._state.incoming.headerFrame == null || this._state.incoming.methodFrame == null)
      throw new AMQPConnectionError('UNEXPECTED_FRAME', 'unexpected AMQP body frame; this is a bug')
    if (bodyFrame)
      this._state.incoming.chunks[this._state.incoming.received++] = bodyFrame.payload
    if (this._state.incoming.received === this._state.incoming.chunks.length) {
      const {methodFrame, headerFrame, chunks} = this._state.incoming
      this._state.incoming = undefined

      let body: MessageBody = Buffer.concat(chunks)
      if (headerFrame.fields.contentType === 'text/plain' && !headerFrame.fields.contentEncoding) {
        body = body.toString()
      } else if (headerFrame.fields.contentType === 'application/json' && !headerFrame.fields.contentEncoding) {
        try {
          body = JSON.parse(body.toString())
        } catch (_) {
          // do nothing; this is a user problem
        }
      }

      const uncastMessage = {
        ...methodFrame.params,
        ...headerFrame.fields,
        durable: headerFrame.fields.deliveryMode === 2,
        body
      }

      if (methodFrame.methodId === Cmd.BasicDeliver) {
        const message: AsyncMessage = uncastMessage as any
        // setImmediate allows basicConsume to resolve first if
        // basic.consume-ok & basic.deliver are received in the same chunk.
        // Also this resets the stack trace for handler()
        setImmediate(() => {
          const handler = this._state.consumers.get(message.consumerTag)
          if (!handler) {
            // this is a bug; missing handler for consumerTag
            // TODO should never happen but maybe close the channel here
          } else {
            // no try-catch; users must handle their own errors
            handler(message)
          }
        })
      } else if (methodFrame.methodId === Cmd.BasicReturn) {
        setImmediate(() => {
          this.emit('basic.return', uncastMessage) // ReturnedMessage
        })
      } else if (methodFrame.methodId === Cmd.BasicGetOK) {
        this._handleRPC(Cmd.BasicGetOK, uncastMessage) // SyncMessage
      }
    }
  }

  /** @internal
   * AMQP does not support RPC pipelining!
   * C = client
   * S = server
   *
   * C:basic.consume
   * C:queue.declare
   * ...
   * S:queue.declare  <- response may arrive out of order
   * S:basic.consume
   *
   * So we can only have one RPC in-flight at a time:
   * C:basic.consume
   * S:basic.consume
   * C:queue.declare
   * S:queue.declare
   **/
  _invoke<P extends Cmd>(req: P, res: Cmd, params: MethodParams[P]): Promise<any> {
    if (!this.active) return Promise.reject(new AMQPChannelError('CH_CLOSE', 'channel is closed'))
    const dfd = createDeferred()
    const it = genFrame({
      type: FrameType.METHOD,
      channelId: this.id,
      methodId: req,
      params: params} as MethodFrame, this._state.maxFrameSize)
    const rpc = [dfd, req, res, it] as const
    if (this._state.rpc)
      this._state.rpcBuffer.push(rpc)
    else
      this._rpcNext(rpc)
    return dfd.promise.catch(recaptureAndThrow)
  }

  /** @internal
   * Start the next RPC */
  _rpcNext([dfd, req, res, it]: typeof this._state.rpcBuffer[number]) {
    this._state.rpc = [dfd, req, res]
    this._state.stream.write(it, (err) => {
      if (err) {
        this._state.rpc = undefined
        dfd.reject(err)
      }
    })
  }

  /** @internal */
  _invokeNowait<T extends Cmd>(methodId: T, params: MethodParams[T]): void {
    if (!this.active)
      throw new AMQPChannelError('CH_CLOSE', 'channel is closed')
    const frame = {
      type: FrameType.METHOD,
      channelId: this.id,
      methodId: methodId,
      params: params
    }
    this._state.stream.write(genFrame(frame as MethodFrame, this._state.maxFrameSize), (err) => {
      if (err) {
        err.message += '; ' + Cmd[methodId]
        this._conn.emit('error', err)
      }
    })
  }

  /**
   * This method publishes a message to a specific exchange. The message will
   * be routed to queues as defined by the exchange configuration.
   *
   * If the body is a string then it will be serialized with
   * contentType='text/plain'. If body is an object then it will be serialized
   * with contentType='application/json'. Buffer objects are unchanged.
   *
   * If publisher-confirms are enabled, then this will resolve when the
   * acknowledgement is received. Otherwise this will resolve after writing to
   * the TCP socket, which is usually immediate. Note that if you keep
   * publishing while the connection is blocked (see
   * {@link Connection#on:BLOCKED | Connection#on('connection.blocked')}) then
   * the TCP socket buffer will eventually fill and this method will no longer
   * resolve immediately. */
  async basicPublish(envelope: Envelope, body: MessageBody): Promise<void>
  /** Send directly to a queue. Same as `basicPublish({routingKey: queue}, body)` */
  async basicPublish(queue: string, body: MessageBody): Promise<void>
  /** @ignore */
  async basicPublish(envelope: string|Envelope, body: MessageBody): Promise<void>
  async basicPublish(params: string|Envelope, body: MessageBody): Promise<void> {
    if (!this.active) return Promise.reject(new AMQPChannelError('CH_CLOSE', 'channel is closed'))
    if (typeof params == 'string') {
      params = {routingKey: params}
    }
    params = Object.assign({timestamp: Math.floor(Date.now() / 1000)}, params)
    params.deliveryMode = (params.durable || params.deliveryMode === 2) ? 2 : 1
    params.rsvp1 = 0
    if (typeof body == 'string') {
      body = Buffer.from(body, 'utf8')
      params.contentType = 'text/plain'
      params.contentEncoding = undefined
    } else if (!Buffer.isBuffer(body)) {
      body = Buffer.from(JSON.stringify(body), 'utf8')
      params.contentType = 'application/json'
      params.contentEncoding = undefined
    }
    await this._state.stream.writeAsync(genContentFrames(this.id, params, body, this._state.maxFrameSize))
    if (this._state.mode === CH_MODE.CONFIRM) {
      // wait for basic.ack or basic.nack
      // note: Unroutable mandatory messages are acknowledged right
      //       after the basic.return method. May be ack'd out-of-order.
      const dfd = createDeferred()
      this._state.unconfirmed.set(this._state.deliveryCount++, dfd)
      return dfd.promise
    }
  }

  /**
   * This is a low-level method; consider using {@link Connection#createConsumer | Connection#createConsumer()} instead.
   *
   * Begin consuming messages from a queue. Consumers last as long as the
   * channel they were declared on, or until the client cancels them. The
   * callback `cb(msg)` is called for each incoming message. You must call
   * {@link Channel#basicAck} to complete the delivery, usually after you've
   * finished some task. */
  async basicConsume(params: MethodParams[Cmd.BasicConsume], cb: (msg: AsyncMessage) => void): Promise<MethodParams[Cmd.BasicConsumeOK]> {
    const data = await this._invoke(Cmd.BasicConsume, Cmd.BasicConsumeOK, {...params, rsvp1: 0, nowait: false})
    const consumerTag = data.consumerTag
    this._state.consumers.set(consumerTag, cb)
    return {consumerTag}
  }

  /** Stop a consumer. */
  basicCancel(consumerTag: string): Promise<MethodParams[Cmd.BasicCancelOK]>
  basicCancel(params: MethodParams[Cmd.BasicCancel]): Promise<MethodParams[Cmd.BasicCancelOK]>
  /** @ignore */
  basicCancel(params: string|MethodParams[Cmd.BasicCancel]): Promise<MethodParams[Cmd.BasicCancelOK]>
  async basicCancel(params: string|MethodParams[Cmd.BasicCancel]): Promise<MethodParams[Cmd.BasicCancelOK]> {
    if (typeof params == 'string') {
      params = {consumerTag: params}
    }
    if (params.consumerTag == null)
      throw new TypeError('consumerTag is undefined; expected a string')
    // note: server may send a few messages before basic.cancel-ok is returned
    const res = await this._invoke(Cmd.BasicCancel, Cmd.BasicCancelOK, {...params, nowait: false})
    this._state.consumers.delete(params.consumerTag)
    return res
  }

  /**
   * This method sets the channel to use publisher acknowledgements.
   * https://www.rabbitmq.com/confirms.html#publisher-confirms
   */
  async confirmSelect(): Promise<void> {
    await this._invoke(Cmd.ConfirmSelect, Cmd.ConfirmSelectOK, {nowait: false})
    this._state.mode = CH_MODE.CONFIRM
  }

  /**
   * Don't use this unless you know what you're doing. This method is provided
   * for the sake of completeness, but you should use `confirmSelect()` instead.
   *
   * Sets the channel to use standard transactions. The client must use this
   * method at least once on a channel before using the Commit or Rollback
   * methods. Mutually exclusive with confirm mode.
   */
  async txSelect(): Promise<void> {
    await this._invoke(Cmd.TxSelect, Cmd.TxSelectOK, undefined)
    this._state.mode = CH_MODE.TRANSACTION
  }

  /** Declare queue, create if needed.  If `queue` empty or undefined then a
   * random queue name is generated (see the return value). */
  queueDeclare(params: MethodParams[Cmd.QueueDeclare]): Promise<MethodParams[Cmd.QueueDeclareOK]>
  queueDeclare(queue?: string): Promise<MethodParams[Cmd.QueueDeclareOK]>
  /** @ignore */
  queueDeclare(params?: string|MethodParams[Cmd.QueueDeclare]): Promise<MethodParams[Cmd.QueueDeclareOK]>
  queueDeclare(params: string|MethodParams[Cmd.QueueDeclare] = ''): Promise<MethodParams[Cmd.QueueDeclareOK]> {
    if (typeof params == 'string') {
      params = {queue: params}
    }
    return this._invoke(Cmd.QueueDeclare, Cmd.QueueDeclareOK, {...params, rsvp1: 0, nowait: false})
  }
  /** Acknowledge one or more messages. */
  basicAck(params: MethodParams[Cmd.BasicAck]): void {
    return this._invokeNowait(Cmd.BasicAck, params)
  }
  /** Request a single message from a queue. Useful for testing. */
  basicGet(params: MethodParams[Cmd.BasicGet]): Promise<undefined|SyncMessage>
  basicGet(queue?: string): Promise<undefined|SyncMessage>
  /** @ignore */
  basicGet(params?: string|MethodParams[Cmd.BasicGet]): Promise<undefined|SyncMessage>
  basicGet(params: string|MethodParams[Cmd.BasicGet] = ''): Promise<undefined|SyncMessage> {
    if (typeof params == 'string') {
      params = {queue: params}
    }
    return this._invoke(Cmd.BasicGet, Cmd.BasicGetOK, {...params, rsvp1: 0})
  }
  /** Reject one or more incoming messages. */
  basicNack(params: MethodParams[Cmd.BasicNack]): void {
    this._invokeNowait(Cmd.BasicNack, {...params, requeue: typeof params.requeue == 'undefined' ? true : params.requeue})
  }
  /** Specify quality of service. */
  async basicQos(params: MethodParams[Cmd.BasicQos]): Promise<void> {
    await this._invoke(Cmd.BasicQos, Cmd.BasicQosOK, params)
  }
  /**
   * This method asks the server to redeliver all unacknowledged messages on a
   * specified channel. Zero or more messages may be redelivered.
   */
  async basicRecover(params: MethodParams[Cmd.BasicRecover]): Promise<void> {
    await this._invoke(Cmd.BasicRecover, Cmd.BasicRecoverOK, params)
  }
  /** Bind exchange to an exchange. */
  async exchangeBind(params: MethodParams[Cmd.ExchangeBind]): Promise<void> {
    if (params.destination == null)
      throw new TypeError('destination is undefined; expected a string')
    if (params.source == null)
      throw new TypeError('source is undefined; expected a string')
    await this._invoke(Cmd.ExchangeBind, Cmd.ExchangeBindOK, {...params, rsvp1: 0, nowait: false})
  }
  /** Verify exchange exists, create if needed. */
  async exchangeDeclare(params: MethodParams[Cmd.ExchangeDeclare]): Promise<void> {
    if (params.exchange == null)
      throw new TypeError('exchange is undefined; expected a string')
    await this._invoke(Cmd.ExchangeDeclare, Cmd.ExchangeDeclareOK, {...params, type: params.type || 'direct', rsvp1: 0, nowait: false})
  }
  /** Delete an exchange. */
  async exchangeDelete(params: MethodParams[Cmd.ExchangeDelete]): Promise<void> {
    if (params.exchange == null)
      throw new TypeError('exchange is undefined; expected a string')
    await this._invoke(Cmd.ExchangeDelete, Cmd.ExchangeDeleteOK, {...params, rsvp1: 0, nowait: false})
  }
  /** Unbind an exchange from an exchange. */
  async exchangeUnbind(params: MethodParams[Cmd.ExchangeUnbind]): Promise<void> {
    if (params.destination == null)
      throw new TypeError('destination is undefined; expected a string')
    if (params.source == null)
      throw new TypeError('source is undefined; expected a string')
    await this._invoke(Cmd.ExchangeUnbind, Cmd.ExchangeUnbindOK, {...params, rsvp1: 0, nowait: false})
  }
  /**
   * This method binds a queue to an exchange. Until a queue is bound it will
   * not receive any messages. In a classic messaging model, store-and-forward
   * queues are bound to a direct exchange and subscription queues are bound to
   * a topic exchange.
   */
  async queueBind(params: MethodParams[Cmd.QueueBind]): Promise<void> {
    if (params.exchange == null)
      throw new TypeError('exchange is undefined; expected a string')
    await this._invoke(Cmd.QueueBind, Cmd.QueueBindOK, {...params, nowait: false})
  }
  /** This method deletes a queue. When a queue is deleted any pending messages
   * are sent to a dead-letter queue if this is defined in the server
   * configuration, and all consumers on the queue are cancelled. If `queue` is
   * empty or undefined then the last declared queue on the channel is used. */
  queueDelete(params: MethodParams[Cmd.QueueDelete]): Promise<MethodParams[Cmd.QueueDeleteOK]>
  queueDelete(queue?: string): Promise<MethodParams[Cmd.QueueDeleteOK]>
  /** @ignore */
  queueDelete(params?: string|MethodParams[Cmd.QueueDelete]): Promise<MethodParams[Cmd.QueueDeleteOK]>
  queueDelete(params: string|MethodParams[Cmd.QueueDelete] = ''): Promise<MethodParams[Cmd.QueueDeleteOK]> {
    if (typeof params == 'string') {
      params = {queue: params}
    }
    return this._invoke(Cmd.QueueDelete, Cmd.QueueDeleteOK, {...params, rsvp1: 0, nowait: false})
  }
  /** Remove all messages from a queue which are not awaiting acknowledgment.
   * If `queue` is empty or undefined then the last declared queue on the
   * channel is used. */
  queuePurge(queue?: string): Promise<MethodParams[Cmd.QueuePurgeOK]>
  queuePurge(params: MethodParams[Cmd.QueuePurge]): Promise<MethodParams[Cmd.QueuePurgeOK]>
  /** @ignore */
  queuePurge(params?: string|MethodParams[Cmd.QueuePurge]): Promise<MethodParams[Cmd.QueuePurgeOK]>
  queuePurge(params: string|MethodParams[Cmd.QueuePurge] = ''): Promise<MethodParams[Cmd.QueuePurgeOK]> {
    if (typeof params == 'string') {
      params = {queue: params}
    }
    return this._invoke(Cmd.QueuePurge, Cmd.QueuePurgeOK, {queue: params.queue, rsvp1: 0, nowait: false})
  }
  /** Unbind a queue from an exchange. */
  async queueUnbind(params: MethodParams[Cmd.QueueUnbind]): Promise<void> {
    if (params.exchange == null)
      throw new TypeError('exchange is undefined; expected a string')
    await this._invoke(Cmd.QueueUnbind, Cmd.QueueUnbindOK, {...params, rsvp1: 0})
  }
  /**
   * This method commits all message publications and acknowledgments performed
   * in the current transaction. A new transaction starts immediately after a
   * commit.
   */
  async txCommit(): Promise<void> {
    await this._invoke(Cmd.TxCommit, Cmd.TxCommitOK, undefined)
  }
  /**
   * This method abandons all message publications and acknowledgments
   * performed in the current transaction. A new transaction starts immediately
   * after a rollback. Note that unacked messages will not be automatically
   * redelivered by rollback; if that is required an explicit recover call
   * should be issued.
   */
  async txRollback(): Promise<void> {
    await this._invoke(Cmd.TxRollback, Cmd.TxRollbackOK, undefined)
  }
}
