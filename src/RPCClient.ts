import {randomBytes} from 'node:crypto'
import {AsyncMessage, MethodParams, Envelope} from './types'
import type Channel from './Channel'
import type Connection from './Connection'
import {createDeferred, Deferred} from './util'
import {AMQPChannelError, AMQPError} from './exception'

export interface RPCProps {
  /** Enable publish-confirm mode. See {@link Channel.confirmSelect} */
  confirm?: boolean
  /** Any exchange-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  exchangeBindings?: Array<MethodParams['exchange.bind']>
  /** Any exchanges to be declared before the consumer and whenever the
   * connection is reset */
  exchanges?: Array<MethodParams['exchange.declare']>
  /** Any queue-exchange bindings to be declared before the consumer and
   * whenever the connection is reset. */
  queueBindings?: Array<MethodParams['queue.bind']>
  /** Define any queues to be declared before the first publish and whenever
   * the connection is reset. Same as {@link Channel.queueDeclare} */
  queues?: Array<MethodParams['queue.declare']>
  /** default=(30000) Max time to wait for a response, in milliseconds.
   * Must be > 0. Note that the acquireTimeout will also affect requests.
   * */
  timeout?: number
}

const DEFAULT_TIMEOUT = 30e3

/**
 * See {@link Connection.createRPCClient} & {@link RPCProps}
 *
 * This is a single "client" Channel on which you may publish messages and
 * listen for responses. You will also need to create a "server" Channel to
 * handle these requests and publish responses. The response message should be
 * published with (at minimum):
 * ```
 * ch.basicPublish({
 *   routingKey: reqmsg.replyTo,
 *   correlationId: reqmsg.correlationId
 * }, messageBody)
 * ```
 *
 * If you're using the createConsumer() helper, then you can reply to RPC
 * requests simply by using the 2nd argument of the {@link ConsumerHandler}.
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
class RPCClient {
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

  /** Perform a RPC. Should resolve with the response message */
  async publish(params: string|Envelope, body: any): Promise<AsyncMessage> {
    if (!this.active)
      throw new AMQPChannelError('RPC_CLOSED', 'RPC client is closed')
    if (!this._ch?.active) {
      if (!this._pendingSetup)
        this._pendingSetup = this._setup().finally(() =>{ this._pendingSetup = undefined })
      await this._pendingSetup
    }

    const id = randomBytes(8).toString('base64url')
    const timeout = this._props.timeout == null ? DEFAULT_TIMEOUT : this._props.timeout
    await this._ch!.basicPublish({
      ...(typeof params === 'string' ? {routingKey: params} : params),
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
    return dfd.promise.finally(() =>{ clearTimeout(timer) })
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

export default RPCClient
