'use strict'
const tape = require('tape')

function getTestArgs() {
  let name = '(anonymous)'
  let opts = {}
  let cb
  for (var i = 0; i < arguments.length; i++) {
    var arg = arguments[i]
    var t = typeof arg
    if (t === 'string') {
      name = arg
    } else if (t === 'object') {
      opts = arg || opts
    } else if (t === 'function') {
      cb = arg
    }
  }
  return {name: name, opts: opts, cb: cb}
}

function isPromise(obj) {
  return !!obj
    && (typeof obj === 'object' || typeof obj === 'function')
    && typeof obj.then === 'function'
}

function tapePromiseFactory(tapeTest) {
  if (tapeTest.Test) {
    tapeTest.Test.prototype.rejects = function (pr, expected, msg) {
      return (typeof pr === 'function' ? pr() : pr)
        .then(() => {
          this.throws(() => {}, expected, msg)
        })
        .catch(err => {
          this.throws(() => { throw err }, expected, msg)
        })
        .then(() => {})
    }
  }

  function testPromise(...args) {
    const {name, opts, cb} = getTestArgs(...args)
    tapeTest(name, opts, function (t) {
      let plan = false
      const setPlan = () => { plan = true }
      t.once('plan', setPlan)
      process.once('unhandledRejection', t.end)
      try {
        const p = cb(t)
        if (isPromise(p)) {
          if (!plan) {
            p.then(() => t.end(), t.end)
          } else {
            p.catch(t.end)
          }
        }
      } catch (err) {
        t.end(err)
      } finally {
        process.removeListener('unhandledRejection', t.end)
        t.removeListener('plan', setPlan)
      }
    })
  }

  Object.keys(tapeTest).forEach((key) => {
    if (typeof tapeTest[key] !== 'function') return
    if (key === 'only') {
      testPromise[key] = tapePromiseFactory(tapeTest[key])
    }
    else {
      testPromise[key] = tapeTest[key]
    }
  })

  return testPromise
}


module.exports = tapePromiseFactory(tape)
