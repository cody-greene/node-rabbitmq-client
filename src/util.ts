import {AMQPConnectionError} from './exception'
import {Readable} from 'stream'
import {promisify} from 'util'

/** @internal */
export interface Deferred<T=any> {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: any) => void
  promise: Promise<T>
}

/** @internal */
export function createDeferred<T=any>(noUncaught?: boolean): Deferred<T> {
  let dfd: any = {}
  dfd.promise = new Promise((resolve, reject) => {
    dfd.resolve = resolve
    dfd.reject = reject
  })
  if (noUncaught)
    dfd.promise.catch(() => {})
  return dfd
}

/**
 * Calculate exponential backoff/retry delay.
 * Where attempts >= 1, exp > 1
 * @example expBackoff(100, 500, 0, attempts)
 *   ---------------------------------
 *    attempts | possible delay
 *   ----------+----------------------
 *        1    | 100, 200
 *        2    | 100, 200, 300, 400
 *        3+   | 100, 200, 300, 400, 500
 *   ---------------------------------
 * Attempts required before max delay is possible = Math.ceil(Math.log(high/step) / Math.log(exp))
 * @internal
 */
export function expBackoff(step: number, high: number, jitter: number, attempts: number, exp?: number): number {
  exp = exp || 2
  const slots = Math.ceil(Math.min(high/step, Math.pow(exp, attempts)))
  const selected = 1 + Math.floor(slots * Math.random())
  const delay = selected * step + Math.floor(Math.random() * jitter * 2) - jitter
  return Math.max(0, Math.min(delay, high))
}

/** @internal */
export function pick(src: any, keys: string[]): any {
  let dest: any = {}
  for (let key of keys) {
    dest[key] = src[key]
  }
  return dest
}

/** @internal */
export function camelCase(string: string): string {
  const parts = string.match(/[^.|-]+/g)
  if (!parts)
    return string
  return parts.reduce((acc, word, index) => {
    return acc + (index ? word.charAt(0).toUpperCase() + word.slice(1) : word)
  })
}

type ReadCB = (err: any, buf: Buffer) => void

/**
 * Wrap Readable.read() to ensure that it either resolves with a Buffer of the
 * requested length, waiting for more data when necessary, or is rejected.
 * Assumes only a single pending read at a time.
 * See also: https://nodejs.org/api/stream.html#readablereadsize
 * @internal
 */
export function createAsyncReader(socket: Readable): (bytes: number) => Promise<Buffer> {
  let bytes: number
  let cb: ReadCB|undefined

  function _read() {
    if (!cb) return
    const buf: Buffer|null = socket.read(bytes)
    if (!buf && socket.readable)
      return // wait for readable OR close
    if (buf?.byteLength !== bytes) {
      cb(new AMQPConnectionError('READ_END',
        'stream ended before all bytes received'), buf!)
    } else {
      cb(null, buf)
    }
    cb = undefined
  }

  socket.on('close', _read)
  socket.on('readable', _read)

  return promisify((_bytes: number, _cb: ReadCB) => {
    bytes = _bytes
    cb = _cb
    _read()
  })
}
