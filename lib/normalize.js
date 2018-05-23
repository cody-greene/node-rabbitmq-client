'use strict'
const URL = require('url').URL
const DEFAULT_CONNECTION = 'amqp://guest:guest@localhost:5672'
const DEFAULT_OPTS = {
  connectionTimeout: 10000, // millis
  evictionInterval: 5000, // millis
  evictionSize: 5,
  frameMax: (128 * 1024), // bytes
  heartbeat: 20, // seconds
  idleTimeout: 30000, // millis
  maxChannels: 0xffff, // 16 bits (protocol max)
  minChannels: 1,
  Promise: Promise
}

/**
 * connectionString
 * protocol
 * hostname, port
 * username, password
 * vhost
 * heartbeat
 * connectionTimeout
 * minChannels
 * maxChannels
 * evictionInterval
 * evictionSize
 * idleTimeout
 */
function normalizeOptions(props) {
  if (typeof props === 'string') {
    props = {connectionString: props}
  }
  props = Object.assign({}, DEFAULT_OPTS, props)
  let url
  if (typeof props.connectionString == 'string') {
    url = new URL(props.connectionString)
    props.username = decodeURIComponent(url.username)
    props.password = decodeURIComponent(url.password)
    props.vhost = decodeURIComponent(url.pathname.split('/')[1] || '/')
    props.hostname = url.hostname
    if (url.port) {
      props.port = url.port
    }
    else {
      if (url.protocol === 'amqp:')
        props.port = url.port = 5672
      else if (url.protocol === 'amqps:')
        props.port = url.port = 5671
      else
        throw new Error('unsupported protocol in connectionString; expected amqp: or amqps:')
    }

    let heartbeat = parseInt(url.searchParams.get('heartbeat'))
    if (!isNaN(heartbeat)) {
      props.heartbeat = Math.max(0, heartbeat)
    }

    let connectionTimeout = parseInt(url.searchParams.get('connection_timeout'))
    if (!isNaN(connectionTimeout)) {
      props.connectionTimeout = Math.max(0, connectionTimeout)
    }

    let maxChannels = parseInt(url.searchParams.get('channel_max'))
    if (!isNaN(maxChannels)) {
      props.maxChannels = Math.min(Math.max(1, maxChannels), props.maxChannels)
    }
  }
  else {
    url = new URL(DEFAULT_CONNECTION)
    if (props.protocol != null) url.protocol = props.protocol
    if (props.hostname != null) url.hostname = props.hostname
    if (props.port != null) url.port = props.port

    if (props.username == null) props.username = url.username
    if (props.password == null) props.password = url.password
    if (props.vhost == null) props.vhost = '/'
  }

  assertNumber(props.connectionTimeout, 'connectionTimeout', 0)
  assertNumber(props.evictionInterval, 'evictionInterval', 0)
  assertNumber(props.evictionSize, 'evictionSize', 1)
  assertNumber(props.frameMax, 'frameMax', 8)
  assertNumber(props.heartbeat, 'heartbeat', 0)
  assertNumber(props.idleTimeout, 'idleTimeout', 1000)
  assertNumber(props.maxChannels, 'maxChannels', 1, DEFAULT_OPTS.maxChannels)
  assertNumber(props.minChannels, 'minChannels', 1)

  // prevent user/pass from showing up in any logs
  url.username = ''
  url.password = ''
  url.search = ''
  url.pathname = ''
  props.connectionString = url.toString()

  return props
}

function assertNumber(val, name, min, max) {
  if (isNaN(val) || !Number.isFinite(val) || val < min || (max != null && val > max)) {
    throw new TypeError(max != null
      ? `${name} must be a number (${min}, ${max})`
      : `${name} must be a number >= ${min}`)
  }
}

module.exports = normalizeOptions
