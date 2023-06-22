import EventEmitter from 'node:events'
import type {AsyncMessage, MethodParams, MessageBody, Envelope, Cmd} from './codec'
import type {Channel} from './Channel'
import type {Connection} from './Connection'
import {READY_STATE, expBackoff, expectEvent} from './util'

/** @internal */
export const IDLE_EVENT = Symbol('idle')
/** @internal */
export const PREFETCH_EVENT = Symbol('prefetch')

type BasicConsumeParams = MethodParams[Cmd.BasicConsume]
export interface ConsumerProps extends BasicConsumeParams {
  /** Non-zero positive integer. Maximum number of messages to process at once.
   * Should be less than or equal to "qos.prefetchCount". Any prefetched, but
   * unworked, messages will be requeued when the underlying channel is closed
   * (unless noAck=true, when every received message will be processed).
   * @default Infinity */
  concurrency?: number,
  /** Requeue message when the handler throws an Error
   * (as with {@link Channel.basicNack})
   * @default true */
  requeue?: boolean,
  /** Additional options when declaring the queue just before creating the
   * consumer and whenever the connection is reset. */
  queueOptions?: MethodParams[Cmd.QueueDeclare],
  /** If defined, basicQos() is invoked just before creating the consumer and
   * whenever the connection is reset */
  qos?: MethodParams[Cmd.BasicQos],
  /** Any exchanges to be declared before the consumer and whenever the
   * connection is reset. See {@link Channel.exchangeDeclare} */
  exchanges?: Array<MethodParams[Cmd.ExchangeDeclare]>
  /** Any queue-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. See {@link Channel.queueBind} */
  queueBindings?: Array<MethodParams[Cmd.QueueBind]>
  /** Any exchange-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. See {@link Channel.exchangeBind} */
  exchangeBindings?: Array<MethodParams[Cmd.ExchangeBind]>
}

/**
 * @param msg The incoming message
 * @param reply Reply to an RPC-type message. Like {@link Channel#basicPublish | Channel#basicPublish()}
 *              but the message body comes first. Some fields are also set automaticaly:
 * - routingKey = msg.replyTo
 * - exchange = ""
 * - correlationId = msg.correlationId
 */
export interface ConsumerHandler {
  (msg: AsyncMessage, reply: (body: MessageBody, envelope?: Envelope) => Promise<void>): Promise<ConsumerReturnCode|void>|ConsumerReturnCode|void
}

export enum ConsumerReturnCode {
  /** BasicAck */
  OK = 0,
  /** BasicNack(requeue=true). The message is returned to the queue. */
  REQUEUE = 1,
  /** BasicNack(requeue=false). The message is dropped and possibly dead-lettered. */
  DROP = 2,
}

export declare interface Consumer {
  /** The consumer is successfully (re)created */
  on(name: 'ready', cb: () => void): this;
  /** Errors are emitted if a message handler fails, or if channel setup fails,
   * or if the consumer is cancelled by the server (like when the queue is deleted). */
  on(name: 'error', cb: (err: any) => void): this;
}

/**
 * @see {@link Connection#createConsumer | Connection#createConsumer()}
 * @see {@link ConsumerProps}
 * @see {@link ConsumerHandler}
 *
 * This will create a dedicated Channel, declare a queue, declare exchanges,
 * declare bindings, establish QoS, and finally start consuming messages. If
 * the connection is reset, then all of this setup will re-run on a new
 * Channel. This uses the same retry-delay logic as the Connection.
 *
 * The callback is called for each incoming message. If it throws an error or
 * returns a rejected Promise then the message is NACK'd (rejected) and
 * possibly requeued, or sent to a dead-letter exchange. The callback can also
 * return a numeric status code to control the ACK/NACK behavior. The
 * {@link ConsumerReturnCode} enum is provided for convenience.
 *
 * ACK/NACK behavior when the callback:
 * - throws an error - BasicNack(requeue=ConsumerProps.requeue)
 * - returns 0 or undefined - BasicAck
 * - returns 1 - BasicNack(requeue=true)
 * - returns 2 - BasicNack(requeue=false)
 *
 * About concurency: For best performance, you'll likely want to start with
 * concurrency=X and qos.prefetchCount=2X. In other words, up to 2X messages
 * are loaded into memory, but only X ConsumerHandlers are running
 * concurrently. The consumer won't need to wait for a new message if one has
 * alredy been prefetched, minimizing idle time. With more worker processes,
 * you will want a lower prefetchCount to avoid worker-starvation.
 *
 * The 2nd argument of `handler(msg, reply)` can be used to reply to RPC
 * requests. e.g. `await reply('my-response-body')`. This acts like
 * basicPublish() except the message body comes first. Some fields are also set
 * automaticaly. See ConsumerHandler for more detail.
 *
 * This is an EventEmitter that may emit errors. Also, since this wraps a
 * Channel, this must be closed before closing the Connection.
 *
 * @example
 * ```
 * const sub = rabbit.createConsumer({queue: 'my-queue'}, async (msg, reply) => {
 *   console.log(msg)
 *   // ... do some work ...
 *
 *   // optionally reply to an RPC-type message
 *   await reply('my-response-data')
 *
 *   // optionally return a status code
 *   return ConsumerReturnCode.OK // 0
 * })
 *
 * sub.on('error', (err) => {
 *   console.log('consumer error (my-queue)', err)
 * })
 *
 * // when closing the application
 * await sub.close()
 * ```
 */
export class Consumer extends EventEmitter {
  /** Maximum number of messages to process at once. Non-zero positive integer.
   * Writeable. */
  concurrency: number
  /** Get current queue name. If the queue name was left blank in
   * ConsumerProps, then this will change whenever the channel is reset, as the
   * name is randomly generated. */
  get queue() { return this._queue }
  /** Get the current consumer ID. If generated by the broker, then this will
   * change each time the consumer is ready. */
  get consumerTag() { return this._consumerTag }

  /** @internal */
  _conn: Connection
  /** @internal */
  _ch?: Channel
  /** @internal */
  _handler: ConsumerHandler
  /** @internal */
  _props: ConsumerProps
  /** @internal */
  _queue = ''
  /** @internal */
  _consumerTag = ''
  /** @internal */
  _prefetched: Array<AsyncMessage> = []
  /** @internal */
  _processing = new Set<Promise<void>>()
  /** @internal */
  _readyState = READY_STATE.CONNECTING
  /** @internal */
  _retryCount = 1
  /** @internal */
  _retryTimer?: NodeJS.Timeout
  /** @internal */
  _pendingSetup?: Promise<void>

  /** @internal */
  constructor(conn: Connection, props: ConsumerProps, handler: ConsumerHandler) {
    super()
    this._conn = conn
    this._handler = handler
    this._props = props
    this._connect = this._connect.bind(this)
    this.concurrency = props.concurrency && Number.isInteger(props.concurrency)
      ? Math.max(1, props.concurrency) : Infinity

    this._connect()
  }

  /** @internal */
  private _makeReplyfn(req: AsyncMessage) {
    return (body: MessageBody, envelope?: Envelope) => {
      if (!req.replyTo)
        throw new Error('attempted to reply to a non-RPC message')
      return this._ch!.basicPublish({
        ...envelope,
        exchange: '',
        routingKey: req.replyTo,
        correlationId: req.correlationId
      }, body)
    }
  }

  /** @internal */
  private async _execHandler(msg: AsyncMessage) {
    // n.b. message MUST ack/nack on the same channel to which it is delivered
    const {_ch: ch} = this
    if (!ch) return // satisfy the type checker but this should never happen
    try {
      let retval
      try {
        retval = await this._handler(msg, this._makeReplyfn(msg))
      } catch (err) {
        if (!this._props.noAck)
          ch.basicNack({deliveryTag: msg.deliveryTag, requeue: this._props.requeue})
        this.emit('error', err)
        return
      }
      if (!this._props.noAck) {
        if (retval === ConsumerReturnCode.DROP)
          ch.basicNack({deliveryTag: msg.deliveryTag, requeue: false})
        else if (retval === ConsumerReturnCode.REQUEUE)
          ch.basicNack({deliveryTag: msg.deliveryTag, requeue: true})
        else
          ch.basicAck({deliveryTag: msg.deliveryTag})
      }
    } catch (err) {
      // ack/nack can fail if the connection dropped
      err.message = 'failed to ack/nack message; ' + err.message
      this.emit('error', err)
    }
  }

  /** @internal*/
  private _prepareMessage(msg: AsyncMessage): void {
      const prom = this._execHandler(msg)
      this._processing.add(prom)
      prom.finally(() => {
        this._processing.delete(prom)
        if (this._processing.size < this.concurrency && this._prefetched.length) {
          this._prepareMessage(this._prefetched.shift()!)
        } else if (!this._processing.size) {
          this.emit(IDLE_EVENT)
        }
      })
  }

  /** @internal */
  private async _setup() {
    // wait for in-progress jobs to complete before retrying
    await Promise.allSettled(this._processing)
    if (this._readyState === READY_STATE.CLOSING) {
      return // abort setup
    }

    let {_ch: ch, _props: props} = this
    if (!ch || !ch.active) {
      ch = this._ch = await this._conn.acquire()
      ch.once('close', () => {
        if (!this._props.noAck) {
          // clear any buffered messages since they can't be ACKd on a new channel
          this._prefetched = []
        }
        if (this._readyState >= READY_STATE.CLOSING) {
          return
        }
        this._readyState = READY_STATE.CONNECTING
        this._reconnect()
        // the channel may close unexpectedly when:
        // - setup failed                               (error already emitted)
        // - connection lost                            (error already emitted)
        // - tried to ack/nack with invalid deliveryTag (error already emitted)
        // - channel forced to close by server action   (NOT emitted)
        //this.emit('error', err)
      })
    }
    const {queue} = await ch.queueDeclare({...props.queueOptions, queue: props.queue})
    this._queue = queue
    if (props.exchanges) for (const params of props.exchanges) {
      await ch.exchangeDeclare(params)
    }
    if (props.queueBindings) for (const params of props.queueBindings) {
      await ch.queueBind(params)
    }
    if (props.exchangeBindings) for (const params of props.exchangeBindings) {
      await ch.exchangeBind(params)
    }
    if (props.qos)
      await ch.basicQos(props.qos)
    const {consumerTag} = await ch.basicConsume(props, (msg) => {
      const shouldBuffer = (this._prefetched.length) // don't skip the queue
        || (this._processing.size >= this.concurrency) // honor the concurrency limit
        || (!this._props.noAck && this._readyState === READY_STATE.CLOSING) // prevent new work while closing
      if (shouldBuffer && Number.isFinite(this.concurrency)) {
        this._prefetched.push(msg)
        this.emit(PREFETCH_EVENT)
      } else {
        this._prepareMessage(msg)
      }
    })
    this._consumerTag = consumerTag
    // n.b. a "basic.cancel" event means the Channel is still usable
    //      e.g. for ack/nack
    // server will send this if the queue is deleted
    ch.once('basic.cancel', (tag, err) => {
      if (this._readyState === READY_STATE.CLOSING)
        return
      this._readyState = READY_STATE.CONNECTING
      this._reconnect()
      this.emit('error', err)
    })

    this._retryCount = 1
    // close() may have been called while setup() is running
    if (this._readyState === READY_STATE.CONNECTING)
      this._readyState = READY_STATE.OPEN
    // user errors in attached event handlers should not cause setup to fail
    process.nextTick(() => this.emit('ready'))
  }

  /** @internal */
  private _connect() {
    this._retryTimer = undefined
    this._pendingSetup = this._setup().finally(() => {
      this._pendingSetup = undefined
    }).catch(err => {
      if (this._readyState >= READY_STATE.CLOSING)
        return
      this._readyState = READY_STATE.CONNECTING
      err.message = 'consumer setup failed; ' + err.message
      // suppress spam if, for example, passive queue declaration is failing
      if (this._retryCount <= 1)
        process.nextTick(() =>{ this.emit('error', err) })
      this._reconnect()
    })
  }

  /** @internal
   * reconnect when:
   * - setup fails
   * - basic.cancel
   * - channel closed
   * - connection closed (triggers channel close)
   */
  private _reconnect() {
    this._consumerTag = ''
    this._queue = ''
    if (this._conn._state.readyState >= READY_STATE.CLOSING || this._retryTimer || this._pendingSetup)
      return
    const {retryLow, retryHigh} = this._conn._opt
    const delay = expBackoff(retryLow, retryHigh, this._retryCount++)
    this._retryTimer = setTimeout(this._connect, delay)
  }

  /** Stop consuming messages. Close the channel once all pending message
   * handlers have settled. If called while the Connection is reconnecting,
   * then this may be delayed by {@link ConnectionOptions.acquireTimeout} */
  async close(): Promise<void> {
    if (this._readyState === READY_STATE.CLOSED)
      return

    this._readyState = READY_STATE.CLOSING
    if (this._retryTimer)
      clearTimeout(this._retryTimer)
    this._retryTimer = undefined
    await this._pendingSetup
    const {_ch: ch} = this
    if (ch?.active && this._consumerTag) {
      // n.b. Some messages may arrive before basic.cancel-ok is received
      const consumerTag = this._consumerTag
      this._consumerTag = ''
      await ch.basicCancel({consumerTag})
    }
    if (!this._props.noAck && this._prefetched.length) {
      // any buffered/unacknowledged messages will be redelivered by the broker
      // after the channel is closed
      this._prefetched = []
    } else if (this._props.noAck && this._prefetched.length) {
      // in this case, buffered messages will not be requeued so we must wait
      // for them to process
      await expectEvent(this, IDLE_EVENT)
    }
    await Promise.allSettled(this._processing)
    await ch?.close()
    this._readyState = READY_STATE.CLOSED
  }
}
