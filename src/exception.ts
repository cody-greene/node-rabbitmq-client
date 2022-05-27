import spec from './spec'

interface AMQPErrorSource {
  classId: number;
  methodId: number;
  replyCode: number;
  replyText: string;
}

/** Low severity, e.g. nack'd message */
class AMQPError extends Error {
  code: string
  /** @internal */
  constructor(code: string|AMQPErrorSource, message?: string) {
    super(message)
    this.name = 'AMQPError'
    if (typeof code == 'object') {
      // connection.close or channel.close event
      let params = code
      code = spec.statusCodes.get(params.replyCode) || 'UNKNOWN'
      const fullName = spec.getFullName(params.classId, params.methodId)
      if (fullName) {
        this.message = `${params.replyText}; ${fullName}`
      } else {
        this.message = params.replyText
      }
    }
    this.code = code
  }
}

/** Medium severity. The channel is closed. */
class AMQPChannelError extends AMQPError {}

/** High severity. All pending actions are rejected and all channels are closed. The connection is reset. */
class AMQPConnectionError extends AMQPChannelError {}

export {AMQPError, AMQPConnectionError, AMQPChannelError}
