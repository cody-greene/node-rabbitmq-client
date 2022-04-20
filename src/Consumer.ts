import EventEmitter from 'events'
import {READY_STATE, AsyncMessage, MethodParams} from './types'
import type Channel from './Channel'
import type Connection from './Connection'
import {expBackoff} from './util'

type BasicConsumeParams = MethodParams['basic.consume']
export interface ConsumerProps extends BasicConsumeParams {
  /** Requeue message when the handler throws an Error (see basicNack) */
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

export type ConsumerHandler = (msg: AsyncMessage) => Promise<void>

declare interface Consumer {
  /** The consumer is successfully (re)created */
  on(name: 'ready', cb: () => void): this;
  /** Errors are emitted if a message handler fails, or if channel setup fails,
   * or if the consumer is cancelled by the server (like when the queue is deleted). */
  on(name: 'error', cb: (err: any) => void): this;
}

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
  _retryCount = 0
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
  private async _processMessage(msg: AsyncMessage) {
    const {_ch: ch} = this
    if (!ch) return // satisfy the type checker but this should never happen
    try {
      try {
        await this._handler(msg)
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

    this._retryCount = 0
    // close() may have been called while setup() is running
    if (this._readyState === READY_STATE.CONNECTING)
      this._readyState = READY_STATE.OPEN
    // user errors in attached event handlers should not cause setup to fail
    process.nextTick(() => this.emit('ready'))
  }

  /** @internal */
  private _connect() {
    this._retryTimer = undefined
    this._pendingSetup = this._setup().catch(err => {
      if (this._readyState === READY_STATE.CLOSING)
        return
      this._readyState = READY_STATE.CONNECTING
      err.message = 'consumer setup failed; ' + err.message
      this._reconnect()
      // suppress spam if, for example, passive queue declaration is failing
      if (this._retryCount <= 1)
        this.emit('error', err)
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
    if (this._conn._state.readyState >= READY_STATE.CLOSING)
      return
    const {retryLow, retryHigh} = this._conn._opt
    const delay = expBackoff(retryLow, retryHigh, 0, this._retryCount++)
    this._retryTimer = setTimeout(this._connect, delay)
  }

  /** Stop consuming messages. Close the channel once all pending message
   * handlers have settled. */
  async close() {
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
