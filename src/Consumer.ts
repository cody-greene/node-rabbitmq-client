import EventEmitter from 'node:events'
import {READY_STATE, AsyncMessage, MethodParams, MessageBody, Envelope} from './types'
import type Channel from './Channel'
import type Connection from './Connection'
import {expBackoff} from './util'

type BasicConsumeParams = MethodParams['basic.consume']
export interface ConsumerProps extends BasicConsumeParams {
  /** (default=true) Requeue message when the handler throws an Error (see
   * {@link Channel.basicNack}) */
  requeue?: boolean,
  /** Additional options when declaring the queue just before creating the
   * consumer and whenever the connection is reset. */
  queueOptions?: Omit<MethodParams['queue.declare'], 'queue' | 'nowait'>,
  /** If defined, basicQos() is invoked just before creating the consumer and
   * whenever the connection is reset */
  qos?: MethodParams['basic.qos'],
  /** Any exchanges to be declared before the consumer and whenever the
   * connection is reset */
  exchanges?: Array<MethodParams['exchange.declare']>
  /** Any queue-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  queueBindings?: Array<MethodParams['queue.bind']>
  /** Any exchange-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  exchangeBindings?: Array<MethodParams['exchange.bind']>
}

export type ReplyFN = (body: MessageBody, envelope?: Envelope) => Promise<void>
/**
 * @param msg The incoming message
 * @param reply Reply to an RPC-type message. Like basicPublish() but the
 * message body comes first, and the routingKey, exchange, and correlationId
 * are automatically set.
 */
export type ConsumerHandler = (msg: AsyncMessage, reply: ReplyFN) => Promise<void>|void

declare interface Consumer {
  /** The consumer is successfully (re)created */
  on(name: 'ready', cb: () => void): this;
  /** Errors are emitted if a message handler fails, or if channel setup fails,
   * or if the consumer is cancelled by the server (like when the queue is deleted). */
  on(name: 'error', cb: (err: any) => void): this;
}

/**
 * See {@link Connection.createConsumer} & {@link ConsumerProps} & {@link ConsumerHandler}
 *
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
class Consumer extends EventEmitter {
  /** @internal */
  _conn: Connection
  /** @internal */
  _ch?: Channel
  /** @internal */
  _handler: ConsumerHandler
  /** @internal */
  _props: ConsumerProps
  /** @internal */
  _consumerTag = ''
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

    this._connect()
  }

  /** @internal */
  private _makeReplyfn(req: AsyncMessage): ReplyFN {
    return (body, envelope) => {
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
  private async _processMessage(msg: AsyncMessage) {
    // n.b. message MUST ack/nack on the same channel to which it is delivered
    const {_ch: ch} = this
    if (!ch) return // satisfy the type checker but this should never happen
    try {
      try {
        await this._handler(msg, this._makeReplyfn(msg))
      } catch (err) {
        if (!this._props.noAck)
          ch.basicNack({deliveryTag: msg.deliveryTag, requeue: this._props.requeue})
        this.emit('error', err)
        return
      }
      if (!this._props.noAck)
        ch.basicAck({deliveryTag: msg.deliveryTag})
    } catch (err) {
      // ack/nack can fail if the connection dropped
      err.message = 'failed to ack/nack message; ' + err.message
      this.emit('error', err)
    }
  }

  /** @internal */
  private async _setup() {
    // wait for in-progress jobs to complete before retrying
    await Promise.allSettled(this._processing)
    this._processing.clear()
    if (this._readyState === READY_STATE.CLOSING) {
      return // abort setup
    }

    let {_ch: ch, _props: props} = this
    if (!ch || !ch.active) {
      ch = this._ch = await this._conn.acquire()
      ch.once('close', () => {
        if (this._readyState === READY_STATE.CLOSING) {
          this._readyState = READY_STATE.CLOSED
          return
        }
        this._readyState = READY_STATE.CONNECTING
        this._consumerTag = ''
        this._reconnect()
        // the channel may close unexpectedly when:
        // - setup failed                               (error already emitted)
        // - connection lost                            (error already emitted)
        // - tried to ack/nack with invalid deliveryTag (error already emitted)
        // - channel forced to close by server action   (NOT emitted)
        //this.emit('error', err)
      })
    }
    await ch.queueDeclare({...props.queueOptions, queue: props.queue})
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
      const promise = this._processMessage(msg)
      if (!props.noAck) {
        // track pending message handlers
        this._processing.add(promise)
        promise.finally(() => { this._processing.delete(promise) })
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
      this._consumerTag = ''
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
      if (this._readyState === READY_STATE.CLOSING)
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
    if (this._readyState === READY_STATE.CLOSING)
      return new Promise(resolve => this._ch!.once('close', resolve))

    this._readyState = READY_STATE.CLOSING
    if (this._retryTimer)
      clearTimeout(this._retryTimer)
    this._retryTimer = undefined
    await this._pendingSetup
    const {_ch: ch} = this
    if (!ch?.active) {
      this._readyState = READY_STATE.CLOSED
      return
    }
    if (this._consumerTag)
      await ch.basicCancel({consumerTag: this._consumerTag})
    await Promise.allSettled(this._processing)
    await ch.close()
  }
}

export default Consumer
