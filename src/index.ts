import Connection from './Connection'

export default Connection
export {Connection}
export {AMQPConnectionError, AMQPChannelError, AMQPError} from './exception'

export type {default as RPCCLient, RPCProps} from './RPCClient'
export type {default as Consumer, ConsumerProps, ConsumerHandler, ReplyFN} from './Consumer'
export type {default as Channel, ConsumerCallback} from './Channel'
export type {ConnectionOptions} from './normalize'
export * from './types'
