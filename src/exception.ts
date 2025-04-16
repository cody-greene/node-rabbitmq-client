/** Low severity, e.g. nack'd message */
class AMQPError extends Error {
  code: string
  /** @internal */
  constructor(code: string, message: string, cause?: unknown) {
    super(message, {cause})
    this.name = 'AMQPError'
    this.code = code
  }
}

/** Medium severity. The channel is closed. */
class AMQPChannelError extends AMQPError {
  /** @internal */
  name = 'AMQPChannelError'
}

/** High severity. All pending actions are rejected and all channels are closed. The connection is reset. */
class AMQPConnectionError extends AMQPChannelError {
  /** @internal */
  name = 'AMQPConnectionError'
}

export {AMQPError, AMQPConnectionError, AMQPChannelError}
