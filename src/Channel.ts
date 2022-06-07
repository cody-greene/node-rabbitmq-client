import Dequeue from './Dequeue'
import {AMQPError, AMQPChannelError, AMQPConnectionError} from './exception'
import {createDeferred, Deferred, EncoderStream} from './util'
import type {AsyncMessage, BodyFrame, Envelope, HeaderFrame, MessageBody, MethodFrame, MethodParams, ReturnedMessage, SyncMessage, SyncMethods} from './types'
import type Connection from './Connection'
import EventEmitter from 'node:events'
import {genContentFrames, genMethodFrame} from './codec'
import SPEC from './spec'

enum CH_MODE {NORMAL, TRANSACTION, CONFIRM}

const NOWAIT_METHODS = [
  'basic.cancel',
  'basic.consume',
  'confirm.select',
  'exchange.bind',
  'exchange.declare',
  'exchange.delete',
  'exchange.unbind',
  'queue.bind',
  'queue.declare',
  'queue.delete',
  'queue.purge'
]

/** For basic.consume */
export type ConsumerCallback = (msg: AsyncMessage) => void
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

type DeferredParams = Deferred<any> // MethodParams[keyof MethodParams]

declare interface Channel {
  /** The specified consumer is stopped by the server. The error param
   * describes the reason for the cancellation. */
  on(name: 'basic.cancel', cb: (consumerTag: string, err: any) => void): this;
  /** This method returns an undeliverable message that was published with the
   * "immediate" flag set, or an unroutable message published with the
   * "mandatory" flag set. The reply code and text provide information about
   * the reason that the message was undeliverable. */
  on(name: 'basic.return', cb: (msg: ReturnedMessage) => void): this;
  on(name: 'close', cb: () => void): this;
}

/** AMQP is a multi-channelled protocol. Channels provide a way to multiplex a
 * heavyweight TCP/IP connection into several light weight connections. This
 * makes the protocol more “firewall friendly” since port usage is predictable.
 * It also means that traffic shaping and other network QoS features can be
 * easily employed. Channels are independent of each other and can perform
 * different functions simultaneously with other channels, the available
 * bandwidth being shared between the concurrent activities.
 * See {@link Connection.acquire} */
class Channel extends EventEmitter {
  /** @internal */
  private _conn: Connection
  readonly id: number

  /** False if the channel is closed */
  active: boolean

  /** @internal */
  private _state: {
    unconfirmed: Map<number, Deferred<void>>
    mode: CH_MODE
    callbacks: Map<string, DeferredParams|Dequeue<DeferredParams>>
    maxFrameSize: number
    /** For tracking consumers created with basic.consume */
    consumers: Map<string, ConsumerCallback>
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
      callbacks: new Map(),
      maxFrameSize: conn._opt.frameMax,
      deliveryCount: 1,
      mode: CH_MODE.NORMAL,
      unconfirmed: new Map(),
      consumers: new Map(),
      stream: new EncoderStream(conn._socket)
    }
    this._state.stream.on('error', async () => {
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
    try {
      this.active = false
      if (this._state.stream.writable) {
        this._state.stream.end()
        // should resolve if the stream drains and ends
        // or if _clear() is called on connection or channel error
        await new Promise<void>(resolve => this._state.stream.on('close', resolve))
      }
      // write directly to the connection in case the channel stream encountered a codec error
      this._conn._writeMethod(this.id, 'channel.close',
        {replyCode: 200, classId: 0, methodId: 0})
      await this._addCallback('channel.close-ok')
    } catch (err) {
      // ignored; if write fails because the connection closed then this is
      // technically a success. Can't have a channel without a connection!
    } finally {
      this._conn._state.leased.delete(this.id)
      this._clear()
      this._conn._checkEmpty()
    }
  }

  /**
   * Save a handler (run-once) for an AMQP synchronous method response
   * @internal
   */
  _addCallback<T extends keyof MethodParams>(classMethod: T): Promise<Required<MethodParams[T]>> {
    const dfd = createDeferred()
    let dequeOrDfd = this._state.callbacks.get(classMethod)
    if (dequeOrDfd == null) {
      this._state.callbacks.set(classMethod, dfd)
    } else if (dequeOrDfd instanceof Dequeue) {
      dequeOrDfd.pushRight(dfd)
    } else {
      this._state.callbacks.set(classMethod, new Dequeue([dequeOrDfd, dfd]))
    }
    return dfd.promise
  }

  /** @internal */
  _resolveCallback<T extends keyof MethodParams>(classMethod: T, params: MethodParams[T]) {
    const dequeOrDfd = this._state.callbacks.get(classMethod)
    if (dequeOrDfd == null) {
      // this is a bug; should never happen
      //console.error(`unexpected incoming method ${this.id}:${classMethod}`, params)
    } else if (dequeOrDfd instanceof Dequeue) {
      const dfd = dequeOrDfd.popLeft()
      if (dfd) {
        dfd.resolve(params)
      } else {
        // this is a bug; should never happen
        //console.error(`unexpected incoming method ${this.id}:${classMethod}`, params)
      }
      if (dequeOrDfd.size < 1) {
        this._state.callbacks.delete(classMethod)
      }
    } else {
      this._state.callbacks.delete(classMethod)
      dequeOrDfd.resolve(params)
    }
  }

  /** @internal Try to reject a pending callback or emit the error */
  _rejectCallback(key: string, err: any) {
    if (typeof key == 'string') {
      if (key === 'basic.publish') {
        // try to reject first unconfirmed message
        for (const [tag, dfd] of this._state.unconfirmed.entries()) {
          this._state.unconfirmed.delete(tag)
          dfd.reject(err)
          return
        }
      } else {
        key = key + '-ok'
      }
    }
    const collection = this._state.callbacks
    const dequeOrDfd = collection.get(key)
    if (dequeOrDfd == null) {
      this._conn.emit('error', err)
    } else if (dequeOrDfd instanceof Dequeue) {
      const dfd = dequeOrDfd.popLeft()
      if (dfd == null)
        this._conn.emit('error', err)
      else
        dfd.reject(err)
      if (dequeOrDfd.size < 1)
        collection.delete(key)
    } else {
      collection.delete(key)
      dequeOrDfd.reject(err)
    }
  }

  /**
   * Invoke all pending response handlers with an error
   * @internal
   */
  _clear(err?: Error) {
    if (err == null)
      err = new AMQPChannelError('CH_CLOSE', 'channel is closed')
    this.active = false
    for (const dequeOrDfd of this._state.callbacks.values()) {
      if (dequeOrDfd instanceof Dequeue) {
        for (const dfd of dequeOrDfd.valuesLeft()) {
          dfd.reject(err)
        }
      } else {
        dequeOrDfd.reject(err)
      }
    }
    for (const dfd of this._state.unconfirmed.values()) {
      dfd.reject(err)
    }
    this._state.callbacks.clear()
    this._state.consumers.clear()
    this._state.unconfirmed.clear()
    this._state.stream.destroy(err)
    this.emit('close')
  }

  /** @internal */
  _onMethod(methodFrame: MethodFrame): void {
    if (this._state.incoming != null) {
      throw new AMQPConnectionError('UNEXPECTED_FRAME',
        'unexpected method frame, already awaiting header/body; this is a bug')
    }
    if (['basic.deliver', 'basic.return', 'basic.get-ok'].includes(methodFrame.fullName)) {
      this._state.incoming = {methodFrame, headerFrame: undefined, chunks: undefined, received: 0}
    } else if (methodFrame.fullName === 'basic.get-empty') {
      // @ts-ignore special case since basic.get-empty is a valid response for basic.get
      this._resolveCallback('basic.get-ok', undefined)
    } else if (this._state.mode === CH_MODE.CONFIRM && methodFrame.fullName === 'basic.ack') {
      const params: Required<MethodParams['basic.ack']> = methodFrame.params as any
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
    } else if (this._state.mode === CH_MODE.CONFIRM && methodFrame.fullName === 'basic.nack') {
      const params: Required<MethodParams['basic.nack']> = methodFrame.params as any
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
    } else if (methodFrame.fullName === 'basic.cancel') {
      const params: Required<MethodParams['basic.cancel']> = methodFrame.params as any
      this._state.consumers.delete(params.consumerTag)
      setImmediate(() => {
        this.emit('basic.cancel', params.consumerTag, new AMQPError('CANCEL_FORCED', 'cancelled by server'))
      })
    } else if (methodFrame.fullName === 'channel.close') {
      const err = new AMQPChannelError(methodFrame.params)
      this._rejectCallback(SPEC.getFullName(methodFrame.params.classId, methodFrame.params.methodId), err)
      this._clear()
      this._conn._writeMethod(methodFrame.channelId, 'channel.close-ok', undefined)
      this._conn._state.leased.delete(this.id)
      this._conn._checkEmpty()
    //} else if (methodFrame.fullName === 'channel.flow') unsupported; https://blog.rabbitmq.com/posts/2014/04/breaking-things-with-rabbitmq-3-3
    } else {
      this._resolveCallback(methodFrame.fullName, methodFrame.params)
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

      if (methodFrame.fullName === 'basic.deliver') {
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
      } else if (methodFrame.fullName === 'basic.return') {
        setImmediate(() => {
          this.emit('basic.return', uncastMessage) // ReturnedMessage
        })
      } else if (methodFrame.fullName === 'basic.get-ok') {
        this._resolveCallback(methodFrame.fullName, uncastMessage) // SyncMessage
      }
    }
  }

  /** @internal */
  async _invoke<T extends SyncMethods>(fullName: T, params: MethodParams[T]): Promise<any> {
    if (!this.active) return activeCheckPromise()
    const it = genMethodFrame(this.id, fullName, params)
    await this._state.stream.writeAsync(it)
    // n.b. nowait is problematic for queue.declare and basic.consume since these
    // can generate random names (queue & consumerTag)
    // @ts-ignore not all methods have the "nowait" param
    if (params?.nowait && NOWAIT_METHODS.includes(fullName))
      return
    // @ts-ignore MethodParams<T-ok>
    return this._addCallback(fullName + '-ok')
  }

  /** @internal */
  _invokeNowait<T extends keyof MethodParams>(fullName: T, params: MethodParams[T]): void {
    if (!this.active)
      throw new AMQPChannelError('CH_CLOSE', 'channel is closed')
    this._state.stream.write(genMethodFrame(this.id, fullName, params), (err) => {
      if (err) {
        err.message += '; ' + fullName
        this._conn.emit('error', err)
      }
    })
  }

  /**
   * This method publishes a message to a specific exchange. The message will
   * be routed to queues as defined by the exchange configuration and
   * distributed to any active consumers when the transaction, if any, is
   * committed.
   *
   * If the body is a string then it will be serialized with
   * contentType='text/plain'. If body is an object then it will be serialized
   * with contentType='application/json'. Buffer objects are unchanged.
   *
   * @param params A queue name for direct routing, as a string, or an Envelope
   * object.
   */
  async basicPublish(params: string|Envelope, body: MessageBody): Promise<void> {
    if (!this.active) return activeCheckPromise()
    if (typeof params == 'string') {
      params = {routingKey: params}
    }
    params = Object.assign({
      deliveryMode: (params.durable || params.deliveryMode === 2) ? 2 : 1,
      timestamp: Math.floor(Date.now() / 1000),
    }, params)
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
   * This method asks the server to start a "consumer", which is a transient
   * request for messages from a specific queue. Consumers last as long as the
   * channel they were declared on, or until the client cancels them.
   */
  async basicConsume(params: MethodParams['basic.consume'], fn: ConsumerCallback): Promise<Required<MethodParams['basic.consume-ok']>> {
    if (params.nowait && !params.consumerTag) {
      throw new Error('consumerTag must be defined when nowait=true')
    }
    // will return undefined when nowait=true
    const data = await this._invoke('basic.consume', params)
    const consumerTag = params.consumerTag || data.consumerTag
    this._state.consumers.set(consumerTag, fn)
    return {consumerTag}
  }

  /** End a queue consumer. */
  async basicCancel(params: string|MethodParams['basic.cancel']): Promise<Required<MethodParams['basic.cancel-ok']>> {
    if (typeof params == 'string') {
      params = {consumerTag: params}
    }
    // note: server may send a few messages before basic.cancel-ok is returned
    const res = await this._invoke('basic.cancel', params)
    this._state.consumers.delete(params.consumerTag)
    return res
  }

  /**
   * This method sets the channel to use publisher acknowledgements. The client
   * can only use this method on a non-transactional channel.
   * https://www.rabbitmq.com/confirms.html#publisher-confirms
   */
  async confirmSelect(): Promise<void> {
    await this._invoke('confirm.select', {})
    this._state.mode = CH_MODE.CONFIRM
  }

  /**
   * This method sets the channel to use standard transactions. The client must
   * use this method at least once on a channel before using the Commit or
   * Rollback methods.
   */
  async txSelect(): Promise<void> {
    await this._invoke('tx.select', undefined)
    this._state.mode = CH_MODE.TRANSACTION
  }

  /**
   * Declare queue, create if needed.
   * If params is undefined then a random queue name is generated (see the
   * return value). If params is a string then it will be used as the queue
   * name.
   */
  async queueDeclare(params?: MethodParams['queue.declare']): Promise<MethodParams['queue.declare-ok']> {
    if (!this.active) return activeCheckPromise()
    if (params == null) {
      params = {}
    } else if (params.nowait && !params.queue) {
      throw new Error('queue must be defined when nowait=true')
    }
    const result = await this._invoke('queue.declare', params)
    if (result == null) {
      // result will be undefined when nowait=true
      return {queue: params.queue!, messageCount: 0, consumerCount: 0}
    }
    return result
  }

  /** Acknowledge one or more messages. */
  basicAck(params: MethodParams['basic.ack']): void {
    return this._invokeNowait('basic.ack', params)
  }
  /** Request a single message from a queue */
  basicGet(params: MethodParams['basic.get']): Promise<undefined|SyncMessage> {
    return this._invoke('basic.get', params)
  }
  /** Reject one or more incoming messages. */
  basicNack(params: MethodParams['basic.nack']): void {
    return this._invokeNowait('basic.nack', params)
  }
  /** Specify quality of service. */
  basicQos(params: MethodParams['basic.qos']): Promise<Required<MethodParams['basic.qos-ok']>> {
    return this._invoke('basic.qos', params)
  }
  /**
   * This method asks the server to redeliver all unacknowledged messages on a
   * specified channel. Zero or more messages may be redelivered.
   */
  basicRecover(params: MethodParams['basic.recover']): Promise<Required<MethodParams['basic.recover-ok']>> {
    return this._invoke('basic.recover', params)
  }
  /** Bind exchange to an exchange. */
  exchangeBind(params: MethodParams['exchange.bind']): Promise<Required<MethodParams['exchange.bind-ok']>> {
    return this._invoke('exchange.bind', params)
  }
  /** Verify exchange exists, create if needed. */
  exchangeDeclare(params: MethodParams['exchange.declare']): Promise<Required<MethodParams['exchange.declare-ok']>> {
    return this._invoke('exchange.declare', params)
  }
  /** Delete an exchange. */
  exchangeDelete(params: MethodParams['exchange.delete']): Promise<Required<MethodParams['exchange.delete-ok']>> {
    return this._invoke('exchange.delete', params)
  }
  /** Unbind an exchange from an exchange. */
  exchangeUnbind(params: MethodParams['exchange.unbind']): Promise<Required<MethodParams['exchange.unbind-ok']>> {
    return this._invoke('exchange.unbind', params)
  }
  /**
   * This method binds a queue to an exchange. Until a queue is bound it will
   * not receive any messages. In a classic messaging model, store-and-forward
   * queues are bound to a direct exchange and subscription queues are bound to
   * a topic exchange.
   */
  queueBind(params: MethodParams['queue.bind']): Promise<Required<MethodParams['queue.bind-ok']>> {
    return this._invoke('queue.bind', params)
  }
  /**
   *  This method deletes a queue. When a queue is deleted any pending messages
   *  are sent to a dead-letter queue if this is defined in the server
   *  configuration, and all consumers on the queue are cancelled.
   */
  queueDelete(params: MethodParams['queue.delete']): Promise<Required<MethodParams['queue.delete-ok']>> {
    return this._invoke('queue.delete', params)
  }
  /**
   * This method removes all messages from a queue which are not awaiting
   * acknowledgment.
   */
  queuePurge(params: MethodParams['queue.purge']): Promise<Required<MethodParams['queue.purge-ok']>> {
    return this._invoke('queue.purge', params)
  }
  /** Unbind a queue from an exchange. */
  queueUnbind(params: MethodParams['queue.unbind']): Promise<Required<MethodParams['queue.unbind-ok']>> {
    return this._invoke('queue.unbind', params)
  }
  /**
   * This method commits all message publications and acknowledgments performed
   * in the current transaction. A new transaction starts immediately after a
   * commit.
   */
  txCommit(params: MethodParams['tx.commit']): Promise<Required<MethodParams['tx.commit-ok']>> {
    return this._invoke('tx.commit', params)
  }
  /**
   * This method abandons all message publications and acknowledgments
   * performed in the current transaction. A new transaction starts immediately
   * after a rollback. Note that unacked messages will not be automatically
   * redelivered by rollback; if that is required an explicit recover call
   * should be issued.
   */
  txRollback(params: MethodParams['tx.rollback']): Promise<Required<MethodParams['tx.rollback-ok']>> {
    return this._invoke('tx.rollback', params)
  }
}

function activeCheckPromise() {
  // This check is very important. The server will end the connection if we
  // attempt to use a closed channel.
  return Promise.reject(new AMQPChannelError('CH_CLOSE', 'channel is closed'))
}

export default Channel
