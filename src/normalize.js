'use strict'
const URL = require('url').URL
const DEFAULT_CONNECTION = 'amqp://guest:guest@localhost:5672'
const TLS_PORT = 5671
const TCP_PORT = 5672
const DEFAULT_OPTS = {
  connectionTimeout: 10000, // millis
  frameMax: (128 * 1024), // bytes
  heartbeat: 23, // seconds
  idleTimeout: 30000, // millis
  maxChannels: 0xffff, // 16 bits (protocol max)
  retryLow: 500,
  retryHigh: 5500,
}

function normalizeOptions(props) {
  if (typeof props === 'string') {
    props = {url: props}
  }
  props = Object.assign({}, DEFAULT_OPTS, props)
  let url
  if (typeof props.url == 'string') {
    url = new URL(props.url)
    props.username = decodeURIComponent(url.username)
    props.password = decodeURIComponent(url.password)
    props.vhost = decodeURIComponent(url.pathname.split('/')[1] || '/')
    props.hostname = url.hostname
    if (url.port) {
      props.port = url.port
    }
    else {
      if (url.protocol === 'amqp:') {
        props.port = url.port = TCP_PORT
      } else if (url.protocol === 'amqps:') {
        props.port = url.port = TLS_PORT
        props.tls = true
      } else {
        throw new Error('unsupported protocol in connectionString; expected amqp: or amqps:')
      }
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
    if (props.hostname == null) props.hostname = url.hostname
    if (props.port == null) props.port = url.port
    if (props.username == null) props.username = url.username
    if (props.password == null) props.password = url.password
    if (props.vhost == null) props.vhost = '/'
  }

  if (Array.isArray(props.hosts)) {
    props.hosts = props.hosts.map(host => {
      let [hostname, port] = host.split(':')
      if (!port) {
        port = props.tls ? TLS_PORT : TCP_PORT
      }
      return {hostname, port}
    })
  }
  else {
    props.hosts = [{hostname: props.hostname, port: props.port}]
  }

  assertNumber(props, 'connectionTimeout', 0)
  assertNumber(props, 'frameMax', 8)
  assertNumber(props, 'heartbeat', 0)
  assertNumber(props, 'idleTimeout', 1000)
  assertNumber(props, 'maxChannels', 1, DEFAULT_OPTS.maxChannels)
  assertNumber(props, 'retryLow', 1)
  assertNumber(props, 'retryHigh', 1)

  return props
}

function assertNumber(props, name, min, max) {
  const val = props[name]
  if (isNaN(val) || !Number.isFinite(val) || val < min || (max != null && val > max)) {
    throw new TypeError(max != null
      ? `${name} must be a number (${min}, ${max})`
      : `${name} must be a number >= ${min}`)
  }
}

module.exports = normalizeOptions
