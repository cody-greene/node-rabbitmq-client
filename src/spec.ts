interface AMQPMethod {
  readonly id: number,
  readonly name: string,
  readonly synchronous: boolean,
  readonly params: ReadonlyArray<{
    readonly name: string,
    readonly type: string,
    readonly defaultValue?: unknown
  }>
}

const EMPTY_OBJ = Object.create(null)
const EMPTY_ARR: never[] = []

/** @internal */
const SPEC = {
  VERSION: [0, 0, 9, 1],
  FRAME_METHOD: 1,
  FRAME_HEADER: 2,
  FRAME_BODY: 3,
  FRAME_HEARTBEAT: 8,
  FRAME_MIN_SIZE: 4096,
  FRAME_END: 206,
  REPLY_SUCCESS: 200,
  statusCodes: new Map([
    [311, 'CONTENT_TOO_LARGE'],
    [312, 'NO_ROUTE'],
    [313, 'NO_CONSUMERS'],
    [403, 'ACCESS_REFUSED'],
    [404, 'NOT_FOUND'],
    [405, 'RESOURCE_LOCKED'],
    [406, 'PRECONDITION_FAILED'],
    [320, 'CONNECTION_FORCED'],
    [402, 'INVALID_PATH'],
    [501, 'FRAME_ERROR'],
    [502, 'SYNTAX_ERROR'],
    [503, 'COMMAND_INVALID'],
    [504, 'CHANNEL_ERROR'],
    [505, 'UNEXPECTED_FRAME'],
    [506, 'RESOURCE_ERROR'],
    [530, 'NOT_ALLOWED'],
    [540, 'NOT_IMPLEMENTED'],
    [541, 'INTERNAL_ERROR'],
  ]),
  getFullName(classId: number, methodId: number): string {
    const def = this.methodById.get((classId << 16) + methodId)
    return def ? def.name : ''
  },
  methodById: new Map<number, AMQPMethod>(),
  methodByName: new Map<string, AMQPMethod>(),
  // id = (classId << 16) + methodId
  // can be read as a single uint32
  methods: [
    {id: 0x000a000a, name: 'connection.start', synchronous: true, params: [{name: 'versionMajor', type: 'octet', defaultValue: 0}, {name: 'versionMinor', type: 'octet', defaultValue: 9}, {name: 'serverProperties', type: 'table'}, {name: 'mechanisms', type: 'longstr', defaultValue: 'PLAIN'}, {name: 'locales', type: 'longstr', defaultValue: 'en_US'}]},
    {id: 0x000a000b, name: 'connection.start-ok', synchronous: false, params: [{name: 'clientProperties', type: 'table'}, {name: 'mechanism', type: 'shortstr', defaultValue: 'PLAIN'}, {name: 'response', type: 'longstr'}, {name: 'locale', type: 'shortstr', defaultValue: 'en_US'}]},
    {id: 0x000a0014, name: 'connection.secure', synchronous: true, params: [{name: 'challenge', type: 'longstr'}]},
    {id: 0x000a0015, name: 'connection.secure-ok', synchronous: false, params: [{name: 'response', type: 'longstr'}]},
    {id: 0x000a001e, name: 'connection.tune', synchronous: true, params: [{name: 'channelMax', type: 'short', defaultValue: 0}, {name: 'frameMax', type: 'long', defaultValue: 0}, {name: 'heartbeat', type: 'short', defaultValue: 0}]},
    {id: 0x000a001f, name: 'connection.tune-ok', synchronous: false, params: [{name: 'channelMax', type: 'short', defaultValue: 0}, {name: 'frameMax', type: 'long', defaultValue: 0}, {name: 'heartbeat', type: 'short', defaultValue: 0}]},
    {id: 0x000a0028, name: 'connection.open', synchronous: true, params: [{name: 'virtualHost', type: 'shortstr', defaultValue: '/'}, {name: 'capabilities', type: 'shortstr', defaultValue: ''}, {name: 'insist', type: 'bit', defaultValue: false}]},
    {id: 0x000a0029, name: 'connection.open-ok', synchronous: false, params: [{name: 'knownHosts', type: 'shortstr', defaultValue: ''}]},
    {id: 0x000a0032, name: 'connection.close', synchronous: true, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'classId', type: 'short'}, {name: 'methodId', type: 'short'}]},
    {id: 0x000a0033, name: 'connection.close-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x000a003c, name: 'connection.blocked', synchronous: false, params: [{name: 'reason', type: 'shortstr', defaultValue: ''}]},
    {id: 0x000a003d, name: 'connection.unblocked', synchronous: false, params: EMPTY_ARR},

    {id: 0x0014000a, name: 'channel.open', synchronous: true, params: [{name: 'outOfBand', type: 'shortstr', defaultValue: ''}]},
    {id: 0x0014000b, name: 'channel.open-ok', synchronous: false, params: [{name: 'channelId', type: 'longstr', defaultValue: ''}]},
    {id: 0x00140014, name: 'channel.flow', synchronous: true, params: [{name: 'active', type: 'bit'}]},
    {id: 0x00140015, name: 'channel.flow-ok', synchronous: false, params: [{name: 'active', type: 'bit'}]},
    {id: 0x00140028, name: 'channel.close', synchronous: true, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'classId', type: 'short'}, {name: 'methodId', type: 'short'}]},
    {id: 0x00140029, name: 'channel.close-ok', synchronous: false, params: EMPTY_ARR},

    {id: 0x001e000a, name: 'access.request', synchronous: true, params: [{name: 'realm', type: 'shortstr', defaultValue: '/data'}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'passive', type: 'bit', defaultValue: true}, {name: 'active', type: 'bit', defaultValue: true}, {name: 'write', type: 'bit', defaultValue: true}, {name: 'read', type: 'bit', defaultValue: true}]},
    {id: 0x001e000b, name: 'access.request-ok', synchronous: false, params: [{name: 'ticket', type: 'short', defaultValue: 1}]},

    {id: 0x0028000a, name: 'exchange.declare', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr'}, {name: 'type', type: 'shortstr', defaultValue: 'direct'}, {name: 'passive', type: 'bit', defaultValue: false}, {name: 'durable', type: 'bit', defaultValue: false}, {name: 'autoDelete', type: 'bit', defaultValue: false}, {name: 'internal', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x0028000b, name: 'exchange.declare-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x00280014, name: 'exchange.delete', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr'}, {name: 'ifUnused', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}]},
    {id: 0x00280015, name: 'exchange.delete-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x0028001e, name: 'exchange.bind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'destination', type: 'shortstr'}, {name: 'source', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x0028001f, name: 'exchange.bind-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x00280028, name: 'exchange.unbind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'destination', type: 'shortstr'}, {name: 'source', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x00280033, name: 'exchange.unbind-ok', synchronous: false, params: EMPTY_ARR},

    {id: 0x0032000a, name: 'queue.declare', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'passive', type: 'bit', defaultValue: false}, {name: 'durable', type: 'bit', defaultValue: false}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'autoDelete', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x0032000b, name: 'queue.declare-ok', synchronous: false, params: [{name: 'queue', type: 'shortstr'}, {name: 'messageCount', type: 'long'}, {name: 'consumerCount', type: 'long'}]},
    {id: 0x00320014, name: 'queue.bind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x00320015, name: 'queue.bind-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x0032001e, name: 'queue.purge', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}]},
    {id: 0x0032001f, name: 'queue.purge-ok', synchronous: false, params: [{name: 'messageCount', type: 'long'}]},
    {id: 0x00320028, name: 'queue.delete', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'ifUnused', type: 'bit', defaultValue: false}, {name: 'ifEmpty', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}]},
    {id: 0x00320029, name: 'queue.delete-ok', synchronous: false, params: [{name: 'messageCount', type: 'long'}]},
    {id: 0x00320032, name: 'queue.unbind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x00320033, name: 'queue.unbind-ok', synchronous: false, params: EMPTY_ARR},

    {id: 0x003c000a, name: 'basic.qos', synchronous: true, params: [{name: 'prefetchSize', type: 'long', defaultValue: 0}, {name: 'prefetchCount', type: 'short', defaultValue: 0}, {name: 'global', type: 'bit', defaultValue: false}]},
    {id: 0x003c000b, name: 'basic.qos-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x003c0014, name: 'basic.consume', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'consumerTag', type: 'shortstr', defaultValue: ''}, {name: 'noLocal', type: 'bit', defaultValue: false}, {name: 'noAck', type: 'bit', defaultValue: false}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
    {id: 0x003c0015, name: 'basic.consume-ok', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}]},
    {id: 0x003c001e, name: 'basic.cancel', synchronous: true, params: [{name: 'consumerTag', type: 'shortstr'}, {name: 'nowait', type: 'bit', defaultValue: false}]},
    {id: 0x003c001f, name: 'basic.cancel-ok', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}]},
    {id: 0x003c0028, name: 'basic.publish', synchronous: false, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr', defaultValue: ''}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'mandatory', type: 'bit', defaultValue: false}, {name: 'immediate', type: 'bit', defaultValue: false}]},
    {id: 0x003c0032, name: 'basic.return', synchronous: false, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}]},
    {id: 0x003c003c, name: 'basic.deliver', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}, {name: 'deliveryTag', type: 'longlong'}, {name: 'redelivered', type: 'bit', defaultValue: false}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}]},
    {id: 0x003c0046, name: 'basic.get', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'noAck', type: 'bit', defaultValue: false}]},
    {id: 0x003c0047, name: 'basic.get-ok', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong'}, {name: 'redelivered', type: 'bit', defaultValue: false}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}, {name: 'messageCount', type: 'long'}]},
    {id: 0x003c0048, name: 'basic.get-empty', synchronous: false, params: [{name: 'clusterId', type: 'shortstr', defaultValue: ''}]},
    {id: 0x003c0050, name: 'basic.ack', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong', defaultValue: 0}, {name: 'multiple', type: 'bit', defaultValue: false}]},
    {id: 0x003c005a, name: 'basic.reject', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong'}, {name: 'requeue', type: 'bit', defaultValue: true}]},
    {id: 0x003c0064, name: 'basic.recover-async', synchronous: false, params: [{name: 'requeue', type: 'bit', defaultValue: false}]},
    {id: 0x003c006e, name: 'basic.recover', synchronous: true, params: [{name: 'requeue', type: 'bit', defaultValue: false}]},
    {id: 0x003c006f, name: 'basic.recover-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x003c0078, name: 'basic.nack', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong', defaultValue: 0}, {name: 'multiple', type: 'bit', defaultValue: false}, {name: 'requeue', type: 'bit', defaultValue: true}]},

    {id: 0x0055000a, name: 'confirm.select', synchronous: true, params: [{name: 'nowait', type: 'bit', defaultValue: false}]},
    {id: 0x0055000b, name: 'confirm.select-ok', synchronous: false, params: EMPTY_ARR},

    {id: 0x005a000a, name: 'tx.select', synchronous: true, params: EMPTY_ARR},
    {id: 0x005a000b, name: 'tx.select-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x005a0014, name: 'tx.commit', synchronous: true, params: EMPTY_ARR},
    {id: 0x005a0015, name: 'tx.commit-ok', synchronous: false, params: EMPTY_ARR},
    {id: 0x005a001e, name: 'tx.rollback', synchronous: true, params: EMPTY_ARR},
    {id: 0x005a001f, name: 'tx.rollback-ok', synchronous: false, params: EMPTY_ARR},
  ],
  headerFields: [
    {type: 'shortstr', name: 'contentType'},
    {type: 'shortstr', name: 'contentEncoding'},
    {type: 'table', name: 'headers'},
    {type: 'octet', name: 'deliveryMode'},
    {type: 'octet', name: 'priority'},
    {type: 'shortstr', name: 'correlationId'},
    {type: 'shortstr', name: 'replyTo'},
    {type: 'shortstr', name: 'expiration'},
    {type: 'shortstr', name: 'messageId'},
    {type: 'timestamp', name: 'timestamp'},
    {type: 'shortstr', name: 'type'},
    {type: 'shortstr', name: 'userId'},
    {type: 'shortstr', name: 'appId'},
    {type: 'shortstr', name: 'clusterId'},
  ]
}

for (const def of SPEC.methods) {
  SPEC.methodById.set(def.id, def)
  SPEC.methodByName.set(def.name, def)
}

/** @internal */
export default SPEC
