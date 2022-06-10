/* eslint no-console: off */
import {performance, createHistogram} from 'node:perf_hooks'
import amqplib from 'amqplib' // npm install --no-save amqplib
import Connection from './src'

declare global {
  namespace NodeJS {
    export interface ProcessEnv {
      MODULE: 'rabbitmq-client' | 'amqplib'
      RABBITMQ_URL: string
      /** Disable Nagle's algorithm (send tcp packets immediately) */
      NO_DELAY: 'true'|'false'
      /** Number of messages to send */
      TOTAL: string
      BATCH_SIZE: string
    }
  }
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || ''
if (!RABBITMQ_URL)
  throw new TypeError('RABBITMQ_URL is unset')
const NO_DELAY = process.env.RABBITMQ_NO_DELAY === 'true'
const MODULE = process.env.MODULE || 'rabbitmq-client'
const TOTAL = Number.parseInt(process.env.TOTAL) || 1000
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE) || Math.ceil(TOTAL * 0.05)

const PAYLOAD = Buffer.from('prometheus')

console.log(`
MODULE=${MODULE}
NO_DELAY=${NO_DELAY}
TOTAL (messages)=${TOTAL}
BATCH_SIZE=${BATCH_SIZE}
`)
if (require.main === module) {
  if (MODULE === 'amqplib')
    main_amqplib()
  else
    main_src()
}

function printHistogram(name: string, pct=false): void {
  const hist = createHistogram()
  let total = 0

  // @ts-ignore
  const start = performance.getEntriesByName('start:' + name, 'mark')
  // @ts-ignore
  const end = performance.getEntriesByName('stop:' + name, 'mark')

  for (let i = 0; i < Math.min(start.length, end.length); ++i) {
    const dur = end[i].startTime - start[i].startTime
    total += dur
    hist.record(Math.ceil(dur))
  }
  total = Math.ceil(total)
  performance.clearMarks('start:' + name)
  performance.clearMarks('stop:' + name)
  console.log(`${name} mean=${hist.mean} min=${hist.min} max=${hist.max} SD=${hist.stddev.toFixed(3)} total=${total}ms`)
  if (pct) console.log(hist.percentiles)
}

async function main_src() {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    heartbeat: 10,
    acquireTimeout: 10e3,
    retryHigh: 5e3,
    noDelay: NO_DELAY
  })

  rabbit.on('error', err => { console.error('connection error', err) })
  rabbit.on('connection.blocked', () => { console.log('connection.blocked') })
  rabbit.on('connection.unblocked', () => { console.log('connection.unblocked') })

  const ch = await rabbit.acquire()
  await ch.confirmSelect()
  await ch.queueDeclare({queue: 'user-events', arguments: {'x-message-ttl': 30000}})

  for (let i = 0; i < TOTAL; i+=BATCH_SIZE) {
    process.stdout.write('.')
    const batchSize = Math.min(i+BATCH_SIZE, TOTAL)
    const pending = new Array(batchSize)
    performance.mark('start:time per batch')
    for (let j = 0; j < batchSize; ++j) {
      pending[j] = ch.basicPublish({routingKey: 'user-events'}, PAYLOAD)
    }
    await Promise.all(pending)
    performance.mark('stop:time per batch')
  }

  await ch.close()
  await rabbit.close()

  console.log('')
  printHistogram('time per batch')
}

async function main_amqplib() {
  const conn = await amqplib.connect(RABBITMQ_URL, {
    noDelay: NO_DELAY
  })
  conn.on('error', err => { console.error('connection error', err) })
  conn.on('blocked', () => { console.log('connection.blocked') })
  conn.on('unblocked', () => { console.log('connection.blocked') })
  const ch = await conn.createConfirmChannel()
  await ch.assertQueue('user-events', {durable: false, arguments: {'x-message-ttl': 30000}})

  for (let i = 0; i < TOTAL; i+=BATCH_SIZE) {
    process.stdout.write('.')
    const batchSize = Math.min(i+BATCH_SIZE, TOTAL)
    performance.mark('start:time per batch')
    for (let j = 0; j < batchSize; ++j) {
      ch.publish('', 'user-events', PAYLOAD, {})
    }
    await ch.waitForConfirms()
    performance.mark('stop:time per batch')
  }

  await ch.close()
  await conn.close()

  console.log('')
  printHistogram('time per batch')
}
