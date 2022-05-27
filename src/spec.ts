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

interface AMQPClass {
  readonly id: number,
  readonly name: string,
  readonly methodById: Map<number, AMQPMethod>,
  readonly methodByName: Map<string, AMQPMethod>,
  readonly methods: ReadonlyArray<AMQPMethod>
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
    const classDef = this.classById.get(classId)
    const methodDef = classDef?.methodById.get(methodId)
    if (classDef && methodDef)
      return classDef.name + '.' + methodDef.name
    return ''
  },
  classById: new Map<number, AMQPClass>(),
  classByName: new Map<string, AMQPClass>(),
  classes: [{
    id: 10,
    name: 'connection',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'start', synchronous: true, params: [{name: 'versionMajor', type: 'octet', defaultValue: 0}, {name: 'versionMinor', type: 'octet', defaultValue: 9}, {name: 'serverProperties', type: 'table'}, {name: 'mechanisms', type: 'longstr', defaultValue: 'PLAIN'}, {name: 'locales', type: 'longstr', defaultValue: 'en_US'}]},
      {id: 11, name: 'start-ok', synchronous: false, params: [{name: 'clientProperties', type: 'table'}, {name: 'mechanism', type: 'shortstr', defaultValue: 'PLAIN'}, {name: 'response', type: 'longstr'}, {name: 'locale', type: 'shortstr', defaultValue: 'en_US'}]},
      {id: 20, name: 'secure', synchronous: true, params: [{name: 'challenge', type: 'longstr'}]},
      {id: 21, name: 'secure-ok', synchronous: false, params: [{name: 'response', type: 'longstr'}]},
      {id: 30, name: 'tune', synchronous: true, params: [{name: 'channelMax', type: 'short', defaultValue: 0}, {name: 'frameMax', type: 'long', defaultValue: 0}, {name: 'heartbeat', type: 'short', defaultValue: 0}]},
      {id: 31, name: 'tune-ok', synchronous: false, params: [{name: 'channelMax', type: 'short', defaultValue: 0}, {name: 'frameMax', type: 'long', defaultValue: 0}, {name: 'heartbeat', type: 'short', defaultValue: 0}]},
      {id: 40, name: 'open', synchronous: true, params: [{name: 'virtualHost', type: 'shortstr', defaultValue: '/'}, {name: 'capabilities', type: 'shortstr', defaultValue: ''}, {name: 'insist', type: 'bit', defaultValue: false}]},
      {id: 41, name: 'open-ok', synchronous: false, params: [{name: 'knownHosts', type: 'shortstr', defaultValue: ''}]},
      {id: 50, name: 'close', synchronous: true, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'classId', type: 'short'}, {name: 'methodId', type: 'short'}]},
      {id: 51, name: 'close-ok', synchronous: false, params: EMPTY_ARR},
      {id: 60, name: 'blocked', synchronous: false, params: [{name: 'reason', type: 'shortstr', defaultValue: ''}]},
      {id: 61, name: 'unblocked', synchronous: false, params: EMPTY_ARR},
    ]
  }, {
    id: 20,
    name: 'channel',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'open', synchronous: true, params: [{name: 'outOfBand', type: 'shortstr', defaultValue: ''}]},
      {id: 11, name: 'open-ok', synchronous: false, params: [{name: 'channelId', type: 'longstr', defaultValue: ''}]},
      {id: 20, name: 'flow', synchronous: true, params: [{name: 'active', type: 'bit'}]},
      {id: 21, name: 'flow-ok', synchronous: false, params: [{name: 'active', type: 'bit'}]},
      {id: 40, name: 'close', synchronous: true, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'classId', type: 'short'}, {name: 'methodId', type: 'short'}]},
      {id: 41, name: 'close-ok', synchronous: false, params: EMPTY_ARR}
    ]
  }, {
    id: 30,
    name: 'access',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'request', synchronous: true, params: [{name: 'realm', type: 'shortstr', defaultValue: '/data'}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'passive', type: 'bit', defaultValue: true}, {name: 'active', type: 'bit', defaultValue: true}, {name: 'write', type: 'bit', defaultValue: true}, {name: 'read', type: 'bit', defaultValue: true}]},
      {id: 11, name: 'request-ok', synchronous: false, params: [{name: 'ticket', type: 'short', defaultValue: 1}]},
    ]
  }, {
    id: 40,
    name: 'exchange',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'declare', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr'}, {name: 'type', type: 'shortstr', defaultValue: 'direct'}, {name: 'passive', type: 'bit', defaultValue: false}, {name: 'durable', type: 'bit', defaultValue: false}, {name: 'autoDelete', type: 'bit', defaultValue: false}, {name: 'internal', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 11, name: 'declare-ok', synchronous: false, params: EMPTY_ARR},
      {id: 20, name: 'delete', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr'}, {name: 'ifUnused', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}]},
      {id: 21, name: 'delete-ok', synchronous: false, params: EMPTY_ARR},
      {id: 30, name: 'bind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'destination', type: 'shortstr'}, {name: 'source', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 31, name: 'bind-ok', synchronous: false, params: EMPTY_ARR},
      {id: 40, name: 'unbind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'destination', type: 'shortstr'}, {name: 'source', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 51, name: 'unbind-ok', synchronous: false, params: EMPTY_ARR},
    ]
  }, {
    id: 50,
    name: 'queue',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'declare', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'passive', type: 'bit', defaultValue: false}, {name: 'durable', type: 'bit', defaultValue: false}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'autoDelete', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 11, name: 'declare-ok', synchronous: false, params: [{name: 'queue', type: 'shortstr'}, {name: 'messageCount', type: 'long'}, {name: 'consumerCount', type: 'long'}]},
      {id: 20, name: 'bind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 21, name: 'bind-ok', synchronous: false, params: EMPTY_ARR},
      {id: 30, name: 'purge', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'nowait', type: 'bit', defaultValue: false}]},
      {id: 31, name: 'purge-ok', synchronous: false, params: [{name: 'messageCount', type: 'long'}]},
      {id: 40, name: 'delete', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'ifUnused', type: 'bit', defaultValue: false}, {name: 'ifEmpty', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}]},
      {id: 41, name: 'delete-ok', synchronous: false, params: [{name: 'messageCount', type: 'long'}]},
      {id: 50, name: 'unbind', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 51, name: 'unbind-ok', synchronous: false, params: EMPTY_ARR},
    ]
  }, {
    id: 60,
    name: 'basic',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'qos', synchronous: true, params: [{name: 'prefetchSize', type: 'long', defaultValue: 0}, {name: 'prefetchCount', type: 'short', defaultValue: 0}, {name: 'global', type: 'bit', defaultValue: false}]},
      {id: 11, name: 'qos-ok', synchronous: false, params: EMPTY_ARR},
      {id: 20, name: 'consume', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'consumerTag', type: 'shortstr', defaultValue: ''}, {name: 'noLocal', type: 'bit', defaultValue: false}, {name: 'noAck', type: 'bit', defaultValue: false}, {name: 'exclusive', type: 'bit', defaultValue: false}, {name: 'nowait', type: 'bit', defaultValue: false}, {name: 'arguments', type: 'table', defaultValue: EMPTY_OBJ}]},
      {id: 21, name: 'consume-ok', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}]},
      {id: 30, name: 'cancel', synchronous: true, params: [{name: 'consumerTag', type: 'shortstr'}, {name: 'nowait', type: 'bit', defaultValue: false}]},
      {id: 31, name: 'cancel-ok', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}]},
      {id: 40, name: 'publish', synchronous: false, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'exchange', type: 'shortstr', defaultValue: ''}, {name: 'routingKey', type: 'shortstr', defaultValue: ''}, {name: 'mandatory', type: 'bit', defaultValue: false}, {name: 'immediate', type: 'bit', defaultValue: false}]},
      {id: 50, name: 'return', synchronous: false, params: [{name: 'replyCode', type: 'short'}, {name: 'replyText', type: 'shortstr', defaultValue: ''}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}]},
      {id: 60, name: 'deliver', synchronous: false, params: [{name: 'consumerTag', type: 'shortstr'}, {name: 'deliveryTag', type: 'longlong'}, {name: 'redelivered', type: 'bit', defaultValue: false}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}]},
      {id: 70, name: 'get', synchronous: true, params: [{name: 'ticket', type: 'short', defaultValue: 0}, {name: 'queue', type: 'shortstr', defaultValue: ''}, {name: 'noAck', type: 'bit', defaultValue: false}]},
      {id: 71, name: 'get-ok', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong'}, {name: 'redelivered', type: 'bit', defaultValue: false}, {name: 'exchange', type: 'shortstr'}, {name: 'routingKey', type: 'shortstr'}, {name: 'messageCount', type: 'long'}]},
      {id: 72, name: 'get-empty', synchronous: false, params: [{name: 'clusterId', type: 'shortstr', defaultValue: ''}]},
      {id: 80, name: 'ack', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong', defaultValue: 0}, {name: 'multiple', type: 'bit', defaultValue: false}]},
      {id: 90, name: 'reject', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong'}, {name: 'requeue', type: 'bit', defaultValue: true}]},
      {id: 100, name: 'recover-async', synchronous: false, params: [{name: 'requeue', type: 'bit', defaultValue: false}]},
      {id: 110, name: 'recover', synchronous: true, params: [{name: 'requeue', type: 'bit', defaultValue: false}]},
      {id: 111, name: 'recover-ok', synchronous: false, params: EMPTY_ARR},
      {id: 120, name: 'nack', synchronous: false, params: [{name: 'deliveryTag', type: 'longlong', defaultValue: 0}, {name: 'multiple', type: 'bit', defaultValue: false}, {name: 'requeue', type: 'bit', defaultValue: true}]},
    ]
  }, {
    id: 85,
    name: 'confirm',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'select', synchronous: true, params: [{name: 'nowait', type: 'bit', defaultValue: false}]},
      {id: 11, name: 'select-ok', synchronous: false, params: EMPTY_ARR},
    ]
  }, {
    id: 90,
    name: 'tx',
    methodByName: new Map<string, AMQPMethod>(),
    methodById: new Map<number, AMQPMethod>(),
    methods: [
      {id: 10, name: 'select', synchronous: true, params: EMPTY_ARR},
      {id: 11, name: 'select-ok', synchronous: false, params: EMPTY_ARR},
      {id: 20, name: 'commit', synchronous: true, params: EMPTY_ARR},
      {id: 21, name: 'commit-ok', synchronous: false, params: EMPTY_ARR},
      {id: 30, name: 'rollback', synchronous: true, params: EMPTY_ARR},
      {id: 31, name: 'rollback-ok', synchronous: false, params: EMPTY_ARR},
    ]
  }],
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


for (const classDef of SPEC.classes) {
  SPEC.classById.set(classDef.id, classDef)
  SPEC.classByName.set(classDef.name, classDef)
  for (const method of classDef.methods) {
    classDef.methodById.set(method.id, method)
    classDef.methodByName.set(method.name, method)
  }
}

/** @internal */
export default SPEC
