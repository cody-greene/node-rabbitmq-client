import EventEmitter from 'node:events'

/** @internal */
export enum READY_STATE {CONNECTING, OPEN, CLOSING, CLOSED}

/** @internal */
export interface HeaderFrame {
  type: 'header',
  channelId: number,
  bodySize: number,
  fields: HeaderFields
}

/** @internal */
export interface MethodFrame {
  type: 'method',
  channelId: number,
  fullName: keyof MethodParams,
  params: any
}

/** @internal */
export interface BodyFrame {
  type: 'body',
  channelId: number,
  payload: Buffer
}

/** @internal */
export type DataFrame =
  | HeaderFrame
  | MethodFrame
  | BodyFrame
  | {type: 'heartbeat', channelId: 0}

export interface HeaderFields {
  /** MIME content type. e.g. "application/json" */
  contentType?: string,
  /** MIME content encoding. e.g. "gzip" */
  contentEncoding?: string,
  /** Additional user-defined fields */
  headers?: {
    /** https://www.rabbitmq.com/sender-selected.html */
    'CC'?: string[],
    /** https://www.rabbitmq.com/sender-selected.html */
    'BCC'?: string[],
    [k: string]: any
  },
  /** Non-persistent (1) or persistent (2). Use the "durable" field instead,
   * which is just a boolean-typed alias. */
  deliveryMode?: number,
  /** Message priority, 0 to 9. */
  priority?: number,
  /** Application correlation identifier. */
  correlationId?: string,
  /** https://www.rabbitmq.com/direct-reply-to.html */
  replyTo?: string,
  /** Message TTL, in milliseconds. Note that only when expired messages reach
   * the head of a queue will they actually be discarded (or dead-lettered).
   * Setting the TTL to 0 causes messages to be expired upon reaching a queue
   * unless they can be delivered to a consumer immediately. */
  expiration?: string,
  /** Application message identifier. */
  messageId?: string,
  /** Message timestamp in seconds. */
  timestamp?: number,
  /** Message type name. */
  type?: string,
  /** Creating user id. */
  userId?: string,
  /** Creating application id. */
  appId?: string
}

export interface PublisherProps {
  /** Enable publish-confirm mode. See {@link Channel.confirmSelect} */
  confirm?: boolean,
  /** see {@link Channel.on}('basic.return') */
  onReturn?: (msg: ReturnedMessage) => void,
  /**
   * Define any queues to be declared before the first publish and whenever
   * the connection is reset. Same as {@link Channel.queueDeclare}
   */
  queues?: Array<MethodParams['queue.declare']>
  /**
   * Define any exchanges to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel.exchangeDeclare}
   */
  exchanges?: Array<MethodParams['exchange.declare']>
  /**
   * Define any queue-exchange bindings to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel.queueBind}
   */
  queueBindings?: Array<MethodParams['queue.bind']>
  /**
   * Define any exchange-exchange bindings to be declared before the first publish and
   * whenever the connection is reset. Same as {@link Channel.exchangeBind}
   */
  exchangeBindings?: Array<MethodParams['exchange.bind']>
}

/** see {@link Connection.createPublisher} */
export interface Publisher extends EventEmitter {
  /** Same as {@link Channel.basicPublish} */
  publish(envelope: string|Envelope, body: MessageBody): Promise<void>,
  /** Same as {@link Channel.on}('basic.return') */
  on(name: 'basic.return', cb: (msg: ReturnedMessage) => void): this;
  /** Close the underlying channel */
  close(): Promise<void>
}

export interface Decimal {scale: number, value: number}

export type MessageBody = string|Buffer|any

export type Envelope = HeaderFields & MethodParams['basic.publish'] & {
  /** Alias for "deliveryMode". Published message should be saved to
   * disk and should survive server restarts. */
  durable?: boolean
}

/** May be received after creating a consumer with {@link Channel.basicConsume} */
export type AsyncMessage = HeaderFields & Required<MethodParams['basic.deliver']> & {
  body: MessageBody
}
/** May be recieved in response to {@link Channel.basicGet} */
export type SyncMessage = HeaderFields & Required<MethodParams['basic.get-ok']> & {
  body: MessageBody
}
/** May be received after {@link Channel.basicPublish} mandatory=true or immediate=true */
export type ReturnedMessage = HeaderFields & Required<MethodParams['basic.return']> & {
  body: MessageBody
}

/** @internal Methods which expect a response e.g. basic.get-ok */
export type SyncMethods =
  | 'basic.cancel'
  | 'basic.consume'
  | 'basic.get'
  | 'basic.qos'
  | 'basic.recover'
  | 'channel.close'
  | 'channel.flow'
  | 'channel.open'
  | 'confirm.select'
  | 'connection.close'
  | 'connection.open'
  | 'connection.secure'
  | 'connection.start'
  | 'connection.tune'
  | 'exchange.bind'
  | 'exchange.declare'
  | 'exchange.delete'
  | 'exchange.unbind'
  | 'queue.bind'
  | 'queue.declare'
  | 'queue.delete'
  | 'queue.purge'
  | 'queue.unbind'
  | 'tx.commit'
  | 'tx.rollback'
  | 'tx.select'

/** Full list of AMQP request/response params */
export interface MethodParams {
  'basic.ack': {
    /** The server-assigned and channel-specific delivery tag */
    deliveryTag?: number,
    /** If set to 1, the delivery tag is treated as "up to and including", so
     * that multiple messages can be acknowledged with a single method. If set
     * to zero, the delivery tag refers to a single message. If the multiple
     * field is 1, and the delivery tag is zero, this indicates acknowledgement
     * of all outstanding messages. */
    multiple?: boolean
  },
  'basic.cancel': {consumerTag: string, nowait?: boolean},
  'basic.cancel-ok': {consumerTag: string},
  'basic.consume': {
    arguments?: {
      /** https://www.rabbitmq.com/consumer-priority.html */
      'x-priority'?: number,
      /** https://www.rabbitmq.com/ha.html#cancellation */
      'x-cancel-on-ha-failover'?: boolean,
      [k: string]: unknown
    },
    /** Specifies the identifier for the consumer. The consumer tag is local to
     * a channel, so two clients can use the same consumer tags. If this field
     * is empty the server will generate a unique tag. */
    consumerTag?: string,
    /** Request exclusive consumer access, meaning only this consumer can
     * access the queue. */
    exclusive?: boolean,
    /** If this field is set the server does not expect acknowledgements for
     * messages. That is, when a message is delivered to the client the server
     * assumes the delivery will succeed and immediately dequeues it. This
     * functionality may increase performance but at the cost of reliability.
     * Messages can get lost if a client dies before they are delivered to the
     * application. */
    noAck?: boolean,
    /** If the no-local field is set the server will not send messages to the
     * connection that published them. */
    noLocal?: boolean,
    /** Not supported */
    nowait?: boolean,
    /** Specifies the name of the queue to consume from. If blank then the last
     * declared queue (on the channel) will be used.*/
    queue?: string,
  },
  'basic.consume-ok': {consumerTag: string},
  'basic.deliver': {
    /** Identifier for the consumer, valid within the current channel. */
    consumerTag: string,
    /** The server-assigned and channel-specific delivery tag */
    deliveryTag: number,
    /** Specifies the name of the exchange that the message was originally
     * published to. May be empty, indicating the default exchange. */
    exchange: string,
    /** This indicates that the message has been previously delivered to this
     * or another client. */
    redelivered?: boolean,
    /** Specifies the routing key name specified when the message was
     * published. */
    routingKey: string
  },
  'basic.get': {
    /** Specifies the name of the queue to consume from. */
    queue?: string,
    /** If this field is set the server does not expect acknowledgements for
     * messages. That is, when a message is delivered to the client the server
     * assumes the delivery will succeed and immediately dequeues it. This
     * functionality may increase performance but at the cost of reliability.
     * Messages can get lost if a client dies before they are delivered to the
     * application. */
    noAck?: boolean
  },
  'basic.get-empty': void,
  'basic.get-ok': {deliveryTag: number, redelivered?: boolean, exchange: string, routingKey: string, messageCount: number},
  'basic.nack': {
    deliveryTag?: number,
    /** If set to 1, the delivery tag is treated as "up to and including", so
     * that multiple messages can be rejected with a single method. If set to
     * zero, the delivery tag refers to a single message. If the multiple field
     * is 1, and the delivery tag is zero, this indicates rejection of all
     * outstanding messages. */
    multiple?: boolean,
    /** (default=true) If requeue is true, the server will attempt to requeue
     * the message. If requeue is false or the requeue attempt fails the
     * messages are discarded or dead-lettered. The default should be TRUE,
     * according to the AMQP specification, however this can lead to an endless
     * retry-loop if you're not careful. Messages consumed from a {@link
     * https://www.rabbitmq.com/quorum-queues.html#poison-message-handling |
     * quorum queue} will have the "x-delivery-count" header, allowing you to
     * discard a message after too many attempted deliveries. For classic
     * mirrored queues, or non-mirrored queues, you will need to construct your
     * own mechanism for discarding poison messages. */
    requeue?: boolean
  },
  'basic.publish': {
    /** Specifies the name of the exchange to publish to. The exchange name can
     * be empty, meaning the default exchange. If the exchange name is
     * specified, and that exchange does not exist, the server will raise a
     * channel exception. */
    exchange?: string,
    /** This flag tells the server how to react if the message cannot be routed
     * to a queue consumer immediately. If this flag is set, the server will
     * return an undeliverable message with a Return method. If this flag is
     * zero, the server will queue the message, but with no guarantee that it
     * will ever be consumed. */
    immediate?: string,
    /** This flag tells the server how to react if the message cannot be routed
     * to a queue. If this flag is set, the server will return an unroutable
     * message with a Return method. If this flag is zero, the server silently
     * drops the message. */
    mandatory?: boolean,
    /** Specifies the routing key for the message. The routing key is used for
     * routing messages depending on the exchange configuration. */
    routingKey?: string
  },

  'basic.qos': {
    /** The client can request that messages be sent in advance so that when
     * the client finishes processing a message, the following message is
     * already held locally, rather than needing to be sent down the channel.
     * Prefetching gives a performance improvement. This field specifies the
     * prefetch window size in octets. The server will send a message in
     * advance if it is equal to or smaller in size than the available prefetch
     * size (and also falls into other prefetch limits). May be set to zero,
     * meaning "no specific limit", although other prefetch limits may still
     * apply. The prefetch-size is ignored if the no-ack option is set. */
    prefetchSize?: number,
    /** Specifies a prefetch window in terms of whole messages. This field may
     * be used in combination with the prefetch-size field; a message will only
     * be sent in advance if both prefetch windows (and those at the channel
     * and connection level) allow it. The prefetch-count is ignored if the
     * no-ack option is set. */
    prefetchCount?: number,
    /** RabbitMQ has reinterpreted this field. The original specification said:
     * "By default the QoS settings apply to the current channel only. If this
     * field is set, they are applied to the entire connection." Instead,
     * RabbitMQ takes global=false to mean that the QoS settings should apply
     * per-consumer (for new consumers on the channel; existing ones being
     * unaffected) and global=true to mean that the QoS settings should apply
     * per-channel. */
    global?: boolean
  },
  'basic.qos-ok': void,
  'basic.recover': {
    /** If this field is zero, the message will be redelivered to the original
     * recipient. If this bit is 1, the server will attempt to requeue the
     * message, potentially then delivering it to an alternative subscriber. */
    requeue?: boolean
  },
  'basic.recover-async': {requeue?: boolean},
  'basic.recover-ok': void,
  'basic.reject': {deliveryTag: number, requeue?: boolean},
  'basic.return': {replyCode: number, replyText?: string, exchange: string, routingKey: string},

  'channel.close': {replyCode: number, replyText?: string, classId: number, methodId: number},
  'channel.close-ok': void,
  'channel.flow': {active: boolean},
  'channel.flow-ok': {active: boolean},
  'channel.open': {outOfBand?: string},
  'channel.open-ok': {channelId?: string},

  'confirm.select': {nowait?: boolean},
  'confirm.select-ok': void,

  'connection.blocked': {reason?: string},
  'connection.close': {classId: number, methodId: number, replyCode: number, replyText?: string},
  'connection.close-ok': void,
  'connection.open': {capabilities?: string, insist?: boolean, virtualHost?: string},
  'connection.open-ok': {knownHosts?: string},
  'connection.secure': {challenge: string},
  'connection.secure-ok': {response: string},
  'connection.start': {locales?: string, mechanisms?: string, serverProperties: Record<string, unknown>, versionMajor?: number, versionMinor?: number}
  'connection.start-ok': {clientProperties: Record<string, unknown>, locale?: string, mechanism?: string, response: string},
  'connection.tune': {channelMax?: number, frameMax?: number, heartbeat?: number},
  'connection.tune-ok': {channelMax?: number, frameMax?: number, heartbeat?: number},
  'connection.unblocked': void,

  'exchange.bind': {
    /** Specifies the name of the destination exchange to bind. */
    destination: string,
    /** Specifies the name of the source exchange to bind. */
    source: string,
    /** Specifies the routing key for the binding. The routing key is used for
     * routing messages depending on the exchange configuration. Not all
     * exchanges use a routing key - refer to the specific exchange
     * documentation. */
    routingKey?: string,
    nowait?: boolean,
    /** A set of arguments for the binding. The syntax and semantics of these
     * arguments depends on the exchange class. */
    arguments?: Record<string, unknown>
  },
  'exchange.bind-ok': void,
  'exchange.declare': {
    arguments?: {
      /** https://www.rabbitmq.com/ae.html */
      'alternate-exchange'?: string,
      [k: string]: unknown
    },
    /** If set, the exchange is deleted when all queues have finished using it. */
    autoDelete?: boolean,
    /** If set when creating a new exchange, the exchange will be marked as
     * durable. Durable exchanges remain active when a server restarts.
     * Non-durable exchanges (transient exchanges) are purged if/when a server
     * restarts. */
    durable?: boolean,
    /** Exchange names starting with "amq." are reserved for pre-declared and
     * standardised exchanges. The exchange name consists of a non-empty
     * sequence of these characters: letters, digits, hyphen, underscore,
     * period, or colon. */
    exchange: string,
    /** If set, the exchange may not be used directly by publishers, but only
     * when bound to other exchanges. Internal exchanges are used to construct
     * wiring that is not visible to applications. */
    internal?: boolean,
    nowait?: boolean,
    /** If set, the server will reply with Declare-Ok if the exchange already
     * exists with the same name, and raise an error if not. The client can use
     * this to check whether an exchange exists without modifying the server
     * state. When set, all other method fields except name and no-wait are
     * ignored. A declare with both passive and no-wait has no effect.
     * Arguments are compared for semantic equivalence. */
    passive?: boolean,
    /** direct, topic, fanout, or headers: Each exchange belongs to one of a
     * set of exchange types implemented by the server. The exchange types
     * define the functionality of the exchange - i.e. how messages are routed
     * through it. */
    type?: string
  },
  'exchange.declare-ok': void,
  'exchange.delete': {
    /** Name of the exchange */
    exchange: string,
    /** If set, the server will only delete the exchange if it has no queue
     * bindings. If the exchange has queue bindings the server does not delete
     * it but raises a channel exception instead. */
    ifUnused?: boolean,
    nowait?: boolean
  },
  'exchange.delete-ok': void,
  'exchange.unbind': {
    arguments?: Record<string, unknown>,
    /** Specifies the name of the destination exchange to unbind. */
    destination: string,
    nowait?: boolean,
    /** Specifies the routing key of the binding to unbind. */
    routingKey?: string
    /** Specifies the name of the source exchange to unbind. */
    source: string
  },
  'exchange.unbind-ok': void,

  'queue.bind': {
    arguments?: Record<string, unknown>,
    /** Name of the exchange to bind to. */
    exchange: string,
    nowait?: boolean,
    /** Specifies the name of the queue to bind. If blank, then the last
     * declared queue on the channel will be used. */
    queue?: string,
    /** Specifies the routing key for the binding. The routing key is used for
     * routing messages depending on the exchange configuration. Not all
     * exchanges use a routing key - refer to the specific exchange
     * documentation. If the queue name is empty, the server uses the last
     * queue declared on the channel. If the routing key is also empty, the
     * server uses this queue name for the routing key as well. If the queue
     * name is provided but the routing key is empty, the server does the
     * binding with that empty routing key. The meaning of empty routing keys
     * depends on the exchange implementation. */
    routingKey?: string
  },
  'queue.bind-ok': void,
  'queue.declare': {
    arguments?: {
      /** Per-Queue Message TTL https://www.rabbitmq.com/ttl.html#per-queue-message-ttl */
      'x-message-ttl'?: number,
      /** Queue Expiry https://www.rabbitmq.com/ttl.html#queue-ttl */
      'x-expires'?: number,
      /** https://www.rabbitmq.com/dlx.html */
      'x-dead-letter-exchange'?: string,
      /** https://www.rabbitmq.com/dlx.html */
      'x-dead-letter-routing-key'?: string,
      /** https://www.rabbitmq.com/maxlength.html */
      'x-max-length'?: number,
      /** https://www.rabbitmq.com/maxlength.html */
      'x-overflow'?: 'drop-head' | 'reject-publish' | 'reject-publish-dlx',
      /** https://www.rabbitmq.com/priority.html */
      'x-max-priority'?: number,
      /** https://www.rabbitmq.com/quorum-queues.html */
      'x-queue-type'?: 'quorum' | 'classic',
      [k: string]: unknown
    },
    /** If set, the queue is deleted when all consumers have finished using it.
     * The last consumer can be cancelled either explicitly or because its
     * channel is closed. If there was no consumer ever on the queue, it won't
     * be deleted. Applications can explicitly delete auto-delete queues using
     * the Delete method as normal. */
    autoDelete?: boolean,
    /** If set when creating a new queue, the queue will be marked as durable.
     * Durable queues remain active when a server restarts. Non-durable queues
     * (transient queues) are purged if/when a server restarts. Note that
     * durable queues do not necessarily hold persistent messages, although it
     * does not make sense to send persistent messages to a transient queue. */
    durable?: boolean,
    /** Exclusive queues may only be accessed by the current connection, and
     * are deleted when that connection closes. Passive declaration of an
     * exclusive queue by other connections are not allowed. */
    exclusive?: boolean,
    nowait?: boolean,
    /** If set, the server will reply with Declare-Ok if the queue already
     * exists with the same name, and raise an error if not. The client can use
     * this to check whether a queue exists without modifying the server state.
     * When set, all other method fields except name and no-wait are ignored. A
     * declare with both passive and no-wait has no effect. */
    passive?: boolean,
    /** The queue name MAY be empty, in which case the server MUST create a new
     * queue with a unique generated name and return this to the client in the
     * Declare-Ok method. Queue names starting with "amq." are reserved for
     * pre-declared and standardised queues. The queue name can be empty, or a
     * sequence of these characters: letters, digits, hyphen, underscore,
     * period, or colon. */
    queue?: string
  },
  'queue.declare-ok': {queue: string, messageCount: number, consumerCount: number},
  'queue.delete': {
    /** If set, the server will only delete the queue if it has no messages. */
    ifEmpty?: boolean,
    /** If set, the server will only delete the queue if it has no consumers.
     * If the queue has consumers the server does does not delete it but raises
     * a channel exception instead. */
    ifUnused?: boolean,
    nowait?: boolean,
    /** Specifies the name of the queue to delete. */
    queue?: string
  },
  'queue.delete-ok': {messageCount: number},
  'queue.purge': {queue?: string, nowait?: boolean},
  'queue.purge-ok': {messageCount: number},
  'queue.unbind': {
    arguments?: Record<string, unknown>,
    /** The name of the exchange to unbind from. */
    exchange: string,
    /** Specifies the name of the queue to unbind. */
    queue?: string,
    /** Specifies the routing key of the binding to unbind. */
    routingKey?: string
  },
  'queue.unbind-ok': void,

  'tx.commit': void,
  'tx.commit-ok': void,
  'tx.rollback': void,
  'tx.rollback-ok': void,
  'tx.select': void,
  'tx.select-ok': void,
}
