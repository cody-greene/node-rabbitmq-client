'use strict'

/**
 * Iterate over a collection, invoking an async function for each item.
 * @param {iterable} collection
 * @param {func} fn(item, index, next)
 * @param {func} done(err)
 */
function forEachAsync(collection, fn, done, ctx) {
  let expected = 0
  let count = 0
  let complete = false
  let next = err => {
    if (complete) return
    if (err) {
      complete = true
      done(err)
      return
    }
    if (++count === expected) {
      complete = true
      done(null)
    }
  }
  try {
    for (let item of collection) {
      fn.call(ctx, item, expected++, next)
    }
  }
  catch (err) {
    next(err)
  }
  if (expected === 0) process.nextTick(done)
}
