import {AMQPConnectionError} from './exception'
import {Readable, Writable} from 'node:stream'
import {promisify} from 'node:util'
import EventEmitter from 'node:events'

/** @internal */
export enum READY_STATE {CONNECTING, OPEN, CLOSING, CLOSED}

/** @internal */
export interface Deferred<T=any> {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: any) => void
  promise: Promise<T>
}

/** @internal */
export function createDeferred<T=any>(noUncaught?: boolean): Deferred<T> {
  const dfd: any = {}
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
 * @example expBackoff(1000, 30000, attempts)
 *   ---------------------------------
 *    attempts | possible delay
 *   ----------+----------------------
 *        1    | 1000 to 2000
 *        2    | 1000 to 4000
 *        3    | 1000 to 8000
 *        4    | 1000 to 16000
 *        5    | 1000 to 30000
 *   ---------------------------------
 * Attempts required before max delay is possible = Math.ceil(Math.log(high/step) / Math.log(exp))
 * @internal
 */
export function expBackoff(step: number, high: number, attempts: number, exp=2): number {
  const slots = Math.ceil(Math.min(high/step, Math.pow(exp, attempts)))
  const max = Math.min(slots * step, high)
  return Math.floor(Math.random() * (max - step) + step)
}

/** @internal */
export function pick(src: any, keys: string[]): any {
  const dest: any = {}
  for (const key of keys) {
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
    if (this._cur) {
      this._cur[1](err)
      this._cur = undefined
    }
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
    let ok = !this._out.writableNeedDrain
    try {
      // if Nagle's algorithm is enabled, this will reduce latency
      this._out.cork()
      while (ok && (res = it.next()) && !res.done)
        ok = this._out.write(res.value)
    } catch (err) {
      return cb(err)
    } finally {
      this._out.uncork()
      // TODO consider this:
      //process.nextTick(() => this._out.uncork())
    }
    if (res?.done) {
      this._cur = undefined
      cb()
    }
  }
}

/** @internal */
export function expectEvent<T=any>(emitter: EventEmitter, name: string|symbol): Promise<T> {
  return new Promise<T>((resolve) => { emitter.once(name, resolve) })
}

/** @internal */
export function recaptureAndThrow(err: Error): any {
  Error.captureStackTrace(err, recaptureAndThrow)
  throw err
}
