declare module 'rmq-client' {
  declare export type MessageBody = string | Buffer | Object

  declare export type Envelope = {
    exchange?: ?string,
    routingKey: string,
    mandatory?: ?boolean,
    headers?: ?Object,
    contentType?: ?string,
    contentEncoding?: ?string,
    durable?: ?boolean,
    priority?: ?number,
    correlationId?: ?string,
    replyTo?: ?string,
    expiration?: ?string,
    messageId?: ?string,
    type?: ?string,
    userId?: ?string,
    appId?: ?string,
  }

  declare export type Message = Envelope & {
    consumerTag: string,
    deliveryTag: number,
    redelivered?: ?boolean,
    timestamp: number,
    body: MessageBody,
  }

  declare export type ReturnedMessage = Envelope & {
    replyCode: number,
    replyText: string,
    timestamp: number,
    body: MessageBody,
  }

  declare export type ConsumerProps = {
    queue: string,
    exclusive?: ?boolean,
    arguments?: ?Object,

    // basic.consume
    consumerTag?: ?string,
    noLocal?: ?boolean,
    noAck?: ?boolean,

    // queue.declare
    passive?: ?boolean,
    autoDelete?: ?boolean,

    // basic.qos
    prefetchSize?: ?number,
    prefetchCount?: ?number,

    // basic.reject
    requeue?: ?boolean,
  }

  declare export type PublisherProps = {
    // enable publisher confirms, and wait for the server to ack messages
    confirm?: ?boolean,
    // watch for unroutable messages (must be published with mandatory=true)
    onBasicReturn?: ?(ReturnedMessage => void),
    // declare all the queues you expect to use
    queues?: ?Array<string | {
      queue?: ?string,
      passive?: ?boolean,
      durable?: ?boolean,
      exclusive?: ?boolean,
      autoDelete?: ?boolean,
      arguments?: ?Object,
    }>
  }

  declare export type Publisher = {
    unblocked: boolean,
    // unlike basicPublish, this always returns a Promise
    publish(string | Envelope, MessageBody): Promise<void>,
    // close the channel
    close(): Promise<void>
  }

  declare export type Consumer = {
    // Stop consuming messages and release the channel
    close(): Promise<void>
  }

  declare export type ConnectionOptions = {
    // 'amqp://guest:guest@localhost:5672?heartbeat=20'
    // supported url params include:
    // - heartbeat
    // - connection_timeout
    // - channel_max
    url?: ?string,
    tls?: ?boolean,
    hostname?: ?string,
    port?: ?number,
    username?: ?string,
    password?: ?string,
    vhost?: ?string,

    // You can list multiple nodes of a cluster.
    // This will reconnect to the next node if one fails.
    // ['hostname:port']
    hosts?: ?Array<string>,

    heartbeat?: ?number, // 20 seconds

    // max wait time when establishing the connection
    connectionTimeout?: ?number, // 10000 milliseconds

    // bounds (in milliseconds) for exponential backoff when reconnecting
    retryLow?: ?number,
    retryHigh?: ?number,

    // Adjust the buffer size on the underlying tcp socket
    // https://nodejs.org/docs/latest-v10.x/api/stream.html#Buffering
    // This will affect connect.unblocked and the drain event
    // The system default seems to be 16kb
    writableHighWaterMark?: ?number, // bytes

    maxChannels?: ?number, // 65535
  }

  declare export class AMQPError extends Error {
    code: string,
    constructor(code: string | {replyCode: number, classId: number, methodId: number}, msg: ?string): void,
  }
  declare export class AMQPChannelError extends AMQPError {}
  declare export class AMQPConnectionError extends AMQPChannelError {}

  declare export class RabbitMQChannel {
    on:
      & (('basic.return', (ReturnedMessage) => void) => void)
      & (('basic.cancel', (consumerTag: string) => void) => void),
    once(string, Function): void,
    off('basic.return' | 'basic.cancel', ?Function): void,
    close(): Promise<void>,

    active: boolean,
    unblocked: boolean,

    basicAck({deliveryTag: string, multiple?: ?boolean}): void,
    basicNack({
      deliveryTag: string,
      multiple?: ?boolean,
      requeue?: ?boolean
    }): void,
    basicReject({deliveryTag: string, requeue?: ?boolean}): void,

    basicCancel(consumerTag: string): Promise<void>,
    basicConsume(string | {
      consumerTag?: ?string,
      exclusive?: ?boolean,
      noAck?: ?boolean,
      noLocal?: ?boolean,
      queue: string,
    }, (Message) => void): Promise<string>,
    basicGet({queue: string, noAck?: ?boolean}): Promise<?Message>,

    // Note this returns a promise when publisher confirms are enabled
    // with confirmSelect()
    basicPublish(string | Envelope, MessageBody): void | Promise<void>,

    basicQos({
      prefetchSize?: ?number,
      prefetchCount?: ?number,
      global?: ?boolean
    }): Promise<void>,
    basicRecover({requeue?: ?boolean}): Promise<void>,

    // Enable publisher confirms
    confirmSelect(): Promise<void>,

    exchangeBind({
      destination: string,
      source: string,
      routingKey: string,
      arguments?: ?Object
    }): Promise<void>,
    exchangeDeclare({
      exchange: string,
      type: string,
      passive?: ?boolean,
      durable?: ?boolean,
      autoDelete?: ?boolean,
      internal?: ?boolean,
      arguments?: ?Object,
    }): Promise<void>,
    exchangeDelete({exchange: string, ifUnused?: ?boolean}): Promise<void>,
    exchangeUnbind({
      destination: string,
      source: string,
      routingKey: string,
      arguments?: ?Object
    }): Promise<void>,
    queueBind({
      queue?: ?string,
      exchange?: ?string,
      routingKey?: ?string,
      arguments?: ?Object
    }): Promise<void>,

    // if the queue name is undefined then one will be randomly generated
    queueDeclare(?string | {
      queue?: ?string,
      passive?: ?boolean,
      durable?: ?boolean,
      exclusive?: ?boolean,
      autoDelete?: ?boolean,
      arguments?: ?Object,
    }): Promise<{queue: string, messageCount: number, consumerCount: number}>,

    queueDelete({
      queue: string,
      ifUnused?: ?boolean,
      ifEmpty?: ?boolean
    }): Promise<{messageCount: number}>,
    queuePurge({queue: string}): Promise<{messageCount: number}>,
    queueUnbind({
      queue?: ?string,
      exchange?: ?string,
      routingKey: string,
      arguments?: ?Object
    }): Promise<void>,
    txCommit(): Promise<void>,
    txRollback(): Promise<void>,
    txSelect(): Promise<void>,
  }

  declare export default class RabbitMQConnection {
    constructor(ConnectionOptions | string): void,

    // https://www.rabbitmq.com/connection-blocked.html
    // False if publishers should wait for the 'drain' event before sending more messages
    // For convenience, this property is also available on channels/publishers
    unblocked: boolean,

    on:
      // triggered when a (re)connection is successful
      & (('connection', () => void): void)
      // triggered when the rabbitmq server is low on resources
      & (('connection.blocked', (reason: string) => void): void)
      // triggered when it's appropriate to resume sending messages
      & (('drain', () => void): void)
      & (('error', Error => void): void),

    once(string, Function): void,

    off('error' | 'connection', ?Function): void,

    // Gracefully close the connection after draining the Channel pool
    close(): Promise<void>,

    // Get a Channel from the internally managed pool
    acquire(): Promise<RabbitMQChannel>,

    // This helper will create a dedicated channel, assert or create a queue,
    // and register a handler for consuming messages.
    // This will also attempt to reestablish the channel after temporary disconnections.
    // If the handler promise is rejected then the message will be returned to the
    // server, otherwise the message will be ack'd.
    // createConsumer('myQueue', ...) is equivalent to {queue: 'myQueue', passive: true}
    createConsumer(string | ConsumerProps, (Message) => Promise<void>): Promise<Consumer>,

    // This helpers will create a dedicated channel, optionally declare several queues,
    // and optionally enable publisher acknowledgments.
    // Like createConsumer(), will also attempt to reestablish the channel if the
    // connection is temporarily lost.
    // Note: this does not return a Promise. The channel is actually created on
    // the first use of publish()
    createPublisher(?PublisherProps): Publisher,

    // This helper will create a dedicated channel in transaction mode and
    // commit/rollback when the handler resolves/rejects
    transaction((RabbitMQChannel) => Promise<void>): Promise<void>,
  }
}
