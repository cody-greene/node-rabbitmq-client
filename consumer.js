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


const amqp = new Connection(AMQP_URL)

const acquire = promisify(amqp.pool.acquire.bind(amqp.pool))

acquire()
  .then(ch => {
    console.log('channel ready')
    // ch.basicQos
    ch.basicConsume({queue: 'foo', noAck: false}, (envelope) => {
      console.log(envelope)
      console.log(envelope.body.toString())
      ch.release()
      amqp.close()
    })
    return ch
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
