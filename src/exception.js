'use strict'

const spec = require('./spec')

function AMQPError(code, message) {
  if (typeof code == 'object') {
    // connection.close or channel.close event
    let params = code
    code = spec.statusCodes.get(params.replyCode)
    message = params.replyText
    let classDef = spec.classes.get(params.classId)
    let methodDef = classDef && classDef.methods.get(params.methodId)
    if (methodDef) {
      message = `${message}; ${classDef.name}.${methodDef.name}`
    }
  }
  this.name = this.constructor.name
  this.code = code
  this.message = message
  Error.captureStackTrace(this, this.constructor)
}
AMQPError.prototype = Object.create(Error.prototype)
AMQPError.prototype.constructor = AMQPError

class AMQPChannelError extends AMQPError {}
class AMQPConnectionError extends AMQPChannelError {}

/**
 * Severity (low < high):
 * AMQPError < AMQPChannelError < AMQPConnectionError
 */
module.exports = {AMQPError, AMQPConnectionError, AMQPChannelError}
