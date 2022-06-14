import {TcpSocketConnectOpts} from 'node:net'
import type {ConnectionOptions as TLSOptions} from 'node:tls'

const DEFAULT_CONNECTION = 'amqp://guest:guest@localhost:5672'
const TLS_PORT = '5671'
const TCP_PORT = '5672'
const DEFAULT_OPTS = {
  acquireTimeout: 20000,
  connectionTimeout: 10000,
  frameMax: 4096,
  heartbeat: 60,
  maxChannels: 0x07ff, // (16bit number so the protocol max is 0xffff)
  retryLow: 1000,
  retryHigh: 30000,
}

export interface ConnectionOptions {
  /** (default=20000) Milliseconds to wait before aborting a Channel creation attempt, i.e. acquire() */
  acquireTimeout?: number,
  /** Custom name for the connection, visible in the server's management UI */
  connectionName?: string,
  /** (default=10000) Max wait time, in milliseconds, for a connection attempt */
  connectionTimeout?: number,
  /** (default=4096) Max size, in bytes, of AMQP data frames. Protocol max is
   * 2^32-1. Actual value is negotiated with the server. */
  frameMax?: number,
  /** (default=60) Period of time, in seconds, after which the TCP connection
   * should be considered unreachable. Server may have its own max value, in
   * which case the lowest of the two is used. A value of 0 will disable this
   * feature. Heartbeats are sent every `heartbeat / 2` seconds, so two missed
   * heartbeats means the connection is dead. */
  heartbeat?: number,
  /** (default=2047) Maximum active AMQP channels. 65535 is the protocol max.
   * The server may also have a max value, in which case the lowest of the two
   * is used. */
  maxChannels?: number,
  /** (default=30000) Max delay, in milliseconds, for exponential-backoff when reconnecting */
  retryHigh?: number,
  /** (default=1000) Step size, in milliseconds, for exponential-backoff when reconnecting */
  retryLow?: number,

  /**
   * (default=amqp://guest:guest@localhost:5672)
   * May also include params: heartbeat, connection_timeout, channel_max
   */
  url?: string,

  hostname?: string,
  port?: string|number,
  vhost?: string,
  password?: string,
  username?: string,

  /** Enable TLS, or set TLS specific options like overriding the CA for
   * self-signed certificates. Automatically enabled if url starts with
   * "amqps:" */
  tls?: boolean|TLSOptions,

  /** Additional options when creating the TCP socket with net.connect(). */
  socket?: TcpSocketConnectOpts,

  /** Disable {@link https://en.wikipedia.org/wiki/Nagle's_algorithm | Nagle's
   * algorithm} for reduced latency. Disabling Nagle’s algorithm will enable the
   * application to have many small packets in flight on the network at once,
   * instead of a smaller number of large packets, which may increase load on
   * the network, and may or may not benefit the application performance. */
  noDelay?: boolean,

  /** "hostname:port" of multiple nodes in a cluster */
  hosts?: string[],
}

type ValidatedKeys =
  | 'acquireTimeout'
  | 'connectionName'
  | 'connectionTimeout'
  | 'frameMax'
  | 'heartbeat'
  | 'maxChannels'
  | 'password'
  | 'retryHigh'
  | 'retryLow'
  | 'username'
  | 'vhost'
interface ValidatedOptions extends Pick<Required<ConnectionOptions>, ValidatedKeys> {
  noDelay?: boolean,
  socket?: TcpSocketConnectOpts,
  tls?: TLSOptions,
  hosts: Array<{hostname: string, port: number}>
}

/** @internal */
export default function normalizeOptions(raw?: string|ConnectionOptions): ValidatedOptions {
  if (typeof raw === 'string') {
    raw = {url: raw}
  }
  const props: any = {...DEFAULT_OPTS, ...raw}
  let url
  if (typeof props.url == 'string') {
    url = new URL(props.url)
    props.username = decodeURIComponent(url.username)
    props.password = decodeURIComponent(url.password)
    props.vhost = decodeURIComponent(url.pathname.split('/')[1] || '/')
    props.hostname = url.hostname
    if (url.port) {
      props.port = url.port
    } else {
      if (url.protocol === 'amqp:') {
        props.port = url.port = TCP_PORT
      } else if (url.protocol === 'amqps:') {
        props.port = url.port = TLS_PORT
        props.tls = props.tls || true
      } else {
        throw new Error('unsupported protocol in connectionString; expected amqp: or amqps:')
      }
    }

    const heartbeat = parseInt(url.searchParams.get('heartbeat')!)
    if (!isNaN(heartbeat)) {
      props.heartbeat = Math.max(0, heartbeat)
    }

    const connectionTimeout = parseInt(url.searchParams.get('connection_timeout')!)
    if (!isNaN(connectionTimeout)) {
      props.connectionTimeout = Math.max(0, connectionTimeout)
    }

    const maxChannels = parseInt(url.searchParams.get('channel_max')!)
    if (!isNaN(maxChannels)) {
      props.maxChannels = Math.min(Math.max(1, maxChannels), props.maxChannels)
    }
  } else {
    url = new URL(DEFAULT_CONNECTION)
    if (props.hostname == null) props.hostname = url.hostname
    if (props.port == null) props.port = url.port
    if (props.username == null) props.username = url.username
    if (props.password == null) props.password = url.password
    if (props.vhost == null) props.vhost = '/'
  }

  if (props.tls === true)
    props.tls = {}

  if (Array.isArray(props.hosts)) {
    props.hosts = props.hosts.map((host: string) => {
      let [hostname, port] = host.split(':')
      if (!port) {
        port = props.tls ? TLS_PORT : TCP_PORT
      }
      return {hostname, port}
    })
  } else {
    props.hosts = [{hostname: props.hostname, port: props.port}]
  }

  assertNumber(props, 'acquireTimeout', 0)
  assertNumber(props, 'connectionTimeout', 0)
  assertNumber(props, 'frameMax', 8, 2**32-1)
  assertNumber(props, 'heartbeat', 0)
  assertNumber(props, 'maxChannels', 1, 2**16-1)
  assertNumber(props, 'retryLow', 1)
  assertNumber(props, 'retryHigh', 1)

  return props
}

function assertNumber(props: Record<string, number>, name: string, min: number, max?: number) {
  const val = props[name]
  if (isNaN(val) || !Number.isFinite(val) || val < min || (max != null && val > max)) {
    throw new TypeError(max != null
      ? `${name} must be a number (${min}, ${max})`
      : `${name} must be a number >= ${min}`)
  }
}
