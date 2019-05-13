'use strict'

module.exports.createDeferred = function createDeferred(Promise) {
  let dfd = {resolve: null, reject: null, promise: null}
  dfd.promise = new Promise((resolve, reject) => {
    dfd.resolve = resolve
    dfd.reject = reject
  })
  return dfd
}

/**
 * Calculate exponential backoff/retry delay
 * @example getDelay(100, 450, ...)
 *   ---------------------------------
 *    attempts | possible delay
 *   ----------+----------------------
 *        0    | 100, 200
 *        1    | 100, 200, 300, 400
 *        2+   | 100, 200, 300, 400, 450
 *   ---------------------------------
 * getDelay(lo: number, hi: number, count: number): number
 */
module.exports.getExpDelay = function getExpDelay(lo, hi, count) {
  const slots = Math.min(Math.pow(2, count + 1), Math.ceil(hi / lo))
  const selected = 1 + Math.floor(slots * Math.random())
  return Math.min(selected * lo, hi)
}

module.exports.pick = function pick(src, keys) {
  let dest = {}
  for (let key of keys) {
    dest[key] = src[key]
  }
  return dest
}

module.exports.camelCase = function camelCase(string) {
  let x = string.match(/[^.|-]+/g).reduce((acc, word, index) => {
    return acc + (index ? word.charAt(0).toUpperCase() + word.slice(1) : word)
  })
  return x
}
