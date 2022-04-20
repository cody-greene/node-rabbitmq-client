
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
