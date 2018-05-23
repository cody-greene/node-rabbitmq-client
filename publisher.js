'use strict'
const Connection = require('./lib/connection')
const AMQP_URL = 'amqp://admin:admin@127.0.0.1:5002?heartbeat=20'

/* eslint-disable no-console */

function promisify(fn) {
  return (...args) => new Promise((resolve, reject) => fn(...args, (err, val) => {
    if (err) reject(err)
    else resolve(val)
  }))
}
function promisifyPick(obj, methods) {
  for (let method of methods) {
    obj[method + 'Async'] = promisify(obj[method].bind(obj))
  }
}

const amqp = new Connection(AMQP_URL)

const acquire = promisify(amqp.pool.acquire.bind(amqp.pool))

function createPublisher(amqp, queueDeclaration, done) {
  amqp.pool.acquire((err, ch) => {
    if (err) return done(err)
    ch.queueDeclare(queueDeclaration, err => {
      if (err) return done(err)
      done(null, ch)
    })
  })
}

acquire()
  .then(ch => {
    console.log('channel ready')
    promisifyPick(ch, ['queueDelete', 'queueDeclare', 'basicPublish'])
    return ch
  })
  .then(ch => {
    return Promise.all([
      ch.queueDeclareAsync({
        queue: 'foo',
        durable: true,
        'arguments': {'x-message-ttl': (5 * 60 * 1000)}
      }),
      ch.basicPublishAsync({routingKey: 'foo'}, {message: 'Hello, AMQP!'}),
    ]).then(() => ch.release())
  })
  .then(() => {
    console.log('ok')
    amqp.close()
  })
  .catch(err => {
    console.log(err.stack)
  })

amqp.on('error', err => {
  console.log('* ' + err.stack)
})

addShutdownListener(() => {
  amqp.close()
})

/**
 * Gracefully exit with SIGINT (^c) or SIGTERM
 * Forcefully exit with SIGQUIT (^\)
 * @param {function} fn Use this to close any open connections or timers so the process can exit
 */
function addShutdownListener(fn) {
  let wrapper = () => {
    process.removeListener('SIGINT', wrapper)
    process.removeListener('SIGTERM', wrapper)
    fn()
  }
  process.on('SIGINT', wrapper).on('SIGTERM', wrapper)
}

module.exports = amqp
