import {AMQPConnectionError} from './exception'
import {Readable, Writable} from 'node:stream'
import {promisify} from 'node:util'

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

/**
 * Consumes Iterators (like from a generator-fn).
 * Writes Buffers (or whatever the iterators produce) to the output stream
 * @internal
 */
export class EncoderStream<T=unknown> extends Writable {
  private _cur?: [Iterator<T, void>, (error?: Error | null) => void]
  private _out: Writable
  constructor(out: Writable) {
    super({objectMode: true})
    this._out = out
    this._loop = this._loop.bind(this)
    out.on('drain', this._loop)
  }
  writeAsync: (it: Iterator<T, void>) => Promise<void> = promisify(this.write)
  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this._out.removeListener('drain', this._loop)
    this._cur = undefined
    cb(err)
  }
  _write(it: Iterator<T, void>, enc: unknown, cb: (error?: Error | null) => void): void {
    this._cur = [it, cb]
    this._loop()
  }
  /** Squeeze the current iterator until it's empty, but respect back-pressure. */
  _loop(): void {
    if (!this._cur) return
    const [it, cb] = this._cur
    let res
    // @ts-ignore Added in node v15.2.0, v14.17.0
    let ok = !this._out.writableNeedDrain
    try {
      while (ok && (res = it.next()) && !res.done)
        ok = this._out.write(res.value)
    } catch (err) {
      return cb(err)
    }
    if (res?.done) {
      this._cur = undefined
      cb()
    }
  }
}
