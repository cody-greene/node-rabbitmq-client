import type {AsyncMessage, MethodParams, Envelope, Cmd} from './codec'
import type {Channel} from './Channel'
import type {Connection} from './Connection'
import {createDeferred, Deferred} from './util'
import {AMQPChannelError, AMQPError} from './exception'

export interface RPCProps {
  /** Enable publish-confirm mode. See {@link Channel.confirmSelect} */
  confirm?: boolean
  /** Any exchange-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  exchangeBindings?: Array<MethodParams[Cmd.ExchangeBind]>
  /** Any exchanges to be declared before the consumer and whenever the
   * connection is reset */
  exchanges?: Array<MethodParams[Cmd.ExchangeDeclare]>
  /** Retries are disabled by default.
   * Increase this number to retry when a request fails due to timeout or
   * connection loss. The Connection options acquireTimeout, retryLow, and
   * retryHigh will affect time between retries.
   * @default 1 */
  maxAttempts?: number
  /** Any queue-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  queueBindings?: Array<MethodParams[Cmd.QueueBind]>
  /** Define any queues to be declared before the first publish and whenever
   * the connection is reset. Same as {@link Channel.queueDeclare} */
  queues?: Array<MethodParams[Cmd.QueueDeclare]>
  /** Max time to wait for a response, in milliseconds.
   * Must be > 0. Note that the acquireTimeout will also affect requests.
   * @default 30_000
   * */
  timeout?: number
}

const DEFAULT_TIMEOUT = 30_000

/**
 * @see {@link Connection#createRPCClient | Connection#createRPCClient()}
 * @see {@link RPCProps}
 * @see {@link https://www.rabbitmq.com/direct-reply-to.html}
 *
 * This will create a single "client" `Channel` on which you may publish
 * messages and listen for direct responses. This can allow, for example, two
 * micro-services to communicate with each other using RabbitMQ as the
 * middleman instead of directly via HTTP.
 *
 * If you're using the createConsumer() helper, then you can reply to RPC
 * requests simply by using the `reply()` argument of
 * the {@link ConsumerHandler}.
 *
 * Also, since this wraps a Channel, this must be closed before closing the
 * Connection: `RPCClient.close()`
 *
 * @example
 * ```
 * // rpc-client.js
 * const rabbit = new Connection()
 *
 * const rpcClient = rabbit.createRPCClient({confirm: true})
 *
 * const res = await rpcClient.send('my-rpc-queue', 'ping')
 * console.log('response:', res.body) // pong
 *
 * await rpcClient.close()
 * await rabbit.close()
 * ```
 *
 * ```
 * // rpc-server.js
 * const rabbit = new Connection()
 *
 * const rpcServer = rabbit.createConsumer({
 *   queue: 'my-rpc-queue'
 * }, async (req, reply) => {
 *   console.log('request:', req.body)
 *   await reply('pong')
 * })
 *
 * process.on('SIGINT', async () => {
 *   await rpcServer.close()
 *   await rabbit.close()
 * })
 * ```
 *
 * If you're communicating with a different rabbitmq client implementation
 * (maybe in a different language) then the consumer should send responses
 * like this:
 * ```
 * ch.basicPublish({
 *   routingKey: req.replyTo,
 *   correlationId: req.correlationId,
 *   exchange: ""
 * }, responseBody)
 * ```
 */
export class RPCClient {
  /** @internal */
  _conn: Connection
  /** @internal */
  _ch?: Channel
  /** @internal */
  _props: RPCProps
  /** @internal */
  _requests = new Map<string, Deferred<AsyncMessage>>()
  /** @internal */
  _pendingSetup?: Promise<void>
  /** @internal CorrelationId counter */
  _id = 0
  /** True while the client has not been explicitly closed */
  active = true

  /** @internal */
  constructor(conn: Connection, props: RPCProps) {
    this._conn = conn
    this._props = props
  }

  /** @internal */
  private async _setup() {
    let {_ch: ch, _props: props} = this
    if (!ch || !ch.active) {
      ch = this._ch = await this._conn.acquire()
      ch.once('close', () => {
        // request-response MUST be on the same channel, so if the channel dies
        // so does all pending requests
        for (const dfd of this._requests.values())
          dfd.reject(new AMQPChannelError('RPC_CLOSED', 'RPC channel closed unexpectedly'))
        this._requests.clear()
      })
    }
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
    if (props.confirm) {
      await ch.confirmSelect()
    }
    // n.b. This is not a real queue & this consumer will not appear in the management UI
    await ch.basicConsume({
      noAck: true,
      queue: 'amq.rabbitmq.reply-to'
    }, (res) => {
      if (res.correlationId) {
        // resolve an exact request
        const dfd = this._requests.get(res.correlationId)
        if (dfd != null) {
          this._requests.delete(res.correlationId)
          dfd.resolve(res)
        }
      }
      // otherwise the response is discarded
    })
    // ch.once('basic.cancel') shouldn't happen
  }

  /** Like {@link Channel#basicPublish}, but it resolves with a response
   * message, or rejects with a timeout.
   * Additionally, some fields are automatically set:
   * - {@link Envelope.replyTo}
   * - {@link Envelope.correlationId}
   * - {@link Envelope.expiration}
   */
  send(envelope: Envelope, body: any): Promise<AsyncMessage>
  /** Send directly to a queue. Same as `send({routingKey: queue}, body)` */
  send(queue: string, body: any): Promise<AsyncMessage>
  /** @ignore */
  send(envelope: string|Envelope, body: any): Promise<AsyncMessage>
  async send(envelope: string|Envelope, body: any): Promise<AsyncMessage> {
    const maxAttempts = this._props.maxAttempts || 1
    let attempts = 0
    while (true) try {
      if (!this.active)
        throw new AMQPChannelError('RPC_CLOSED', 'RPC client is closed')
      if (!this._ch?.active) {
        if (!this._pendingSetup)
          this._pendingSetup = this._setup().finally(() =>{ this._pendingSetup = undefined })
        await this._pendingSetup
      }

      const id = String(++this._id)
      const timeout = this._props.timeout == null ? DEFAULT_TIMEOUT : this._props.timeout
      await this._ch!.basicPublish({
        ...(typeof envelope === 'string' ? {routingKey: envelope} : envelope),
        replyTo: 'amq.rabbitmq.reply-to',
        correlationId: id,
        expiration: String(timeout)
      }, body)

      const dfd = createDeferred<AsyncMessage>()
      const timer = setTimeout(() => {
        dfd.reject(new AMQPError('RPC_TIMEOUT', 'RPC response timed out'))
        this._requests.delete(id)
      }, timeout)
      this._requests.set(id, dfd)

      // remember to stop the timer if we get a response or if there is some other failure
      return await dfd.promise.finally(() =>{ clearTimeout(timer) })
    } catch (err) {
      if (++attempts >= maxAttempts) {
        Error.captureStackTrace(err) // original async trace is likely not useful to users
        throw err
      }
      // else loop; notify with event?
    }
  }

  /** @deprecated Alias for {@link RPCClient#send} */
  publish(envelope: string|Envelope, body: any): Promise<AsyncMessage> {
    return this.send(envelope, body)
  }

  /** Stop consuming messages. Close the channel once all pending message
   * handlers have settled. If called while the Connection is reconnecting,
   * then this may be delayed by {@link ConnectionOptions.acquireTimeout} */
  async close(): Promise<void> {
    this.active = false
    try {
      await this._pendingSetup
      await Promise.allSettled(Array.from(this._requests.values()).map(dfd => dfd.promise))
    } catch (err) {
      // do nothing; task failed successfully
    }
    // Explicitly not cancelling the consumer; it's not necessary.
    await this._ch?.close()
  }
}
