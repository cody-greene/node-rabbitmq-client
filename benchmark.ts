/* eslint no-console: off */
import {performance, createHistogram} from 'node:perf_hooks'
import {randomBytes} from 'node:crypto'
// @ts-ignore
import amqplib from 'amqplib' // npm install --no-save amqplib
import Connection from './lib'

declare global {
  namespace NodeJS {
    export interface ProcessEnv {
      MODULE?: 'rabbitmq-client' | 'amqplib'
      RABBITMQ_URL?: string | undefined
      /** Disable Nagle's algorithm (send tcp packets immediately) */
      NO_DELAY?: 'true'|'false'
      /** Number of messages to send */
      TOTAL?: string
      BATCH_SIZE?: string
    }
  }
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || ''
if (!RABBITMQ_URL)
  throw new TypeError('RABBITMQ_URL is unset')
const NO_DELAY = process.env.RABBITMQ_NO_DELAY === 'true'
const MODULE = process.env.MODULE || 'rabbitmq-client'
const TOTAL = Number.parseInt((process.env.TOTAL || '1000').replace(/_/g, ''))
const BATCH_SIZE = Number.parseInt((process.env.BATCH_SIZE || '').replace(/_/g, '')) || Math.ceil(TOTAL * 0.05)
const ROUTING_KEY = process.env.ROUTING_KEY || 'perf_' + randomBytes(8).toString('hex')

const PAYLOAD = Buffer.from('prometheus')

console.log(`
MODULE=${MODULE}
NO_DELAY=${NO_DELAY}
TOTAL (messages)=${TOTAL}
BATCH_SIZE=${BATCH_SIZE}
ROUTING_KEY=${ROUTING_KEY}
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

  const start = performance.getEntriesByName('start:' + name, 'mark')
  const end = performance.getEntriesByName('stop:' + name, 'mark')

  for (let i = 0; i < Math.min(start.length, end.length); ++i) {
    const dur = end[i].startTime - start[i].startTime
    total += dur
    hist.record(Math.ceil(dur))
  }
  total = Math.ceil(total)
  performance.clearMarks('start:' + name)
  performance.clearMarks('stop:' + name)

  const rows = [
    ['total_time', 'mean', 'std', 'min', 'max'],
    [total.toFixed(0), hist.mean.toFixed(3), hist.stddev.toFixed(3), hist.min.toFixed(3), hist.max.toFixed(3)]
  ]

  const width = new Array(rows[0].length)
  for (let j = 0; j < rows[0].length; ++j) {
    width[j] = 0
    for (let i = 0; i < rows.length; ++i) {
      const len = rows[i][j].length
      if (width[j] < len)
        width[j] = len
    }
  }
  let table = ''
  for (let i = 0; i < rows.length; ++i) {
    for (let j = 0; j < rows[i].length; ++j) {
      table += '  ' + rows[i][j].padEnd(width[j])
    }
    table += '\n'
  }

  console.log(`${name}\n${table}`)
  if (pct) console.log(hist.percentiles)
}

async function main_src() {
  const rabbit = new Connection({
    url: RABBITMQ_URL,
    noDelay: NO_DELAY
  })

  rabbit.on('error', err => { console.error('connection error', err) })
  rabbit.on('connection.blocked', () => { console.log('connection.blocked') })
  rabbit.on('connection.unblocked', () => { console.log('connection.unblocked') })

  const ch = await rabbit.acquire()
  await ch.confirmSelect()

  const hs = 'time per batch (milliseconds)'
  for (let i = 0; i < TOTAL; i+=BATCH_SIZE) {
    const pending = new Array(BATCH_SIZE)
    performance.mark('start:' + hs)
    for (let j = 0; j < BATCH_SIZE; ++j) {
      pending[j] = ch.basicPublish({routingKey: ROUTING_KEY}, PAYLOAD)
    }
    await Promise.all(pending)
    performance.mark('stop:' + hs)
  }

  await ch.close()
  await rabbit.close()

  console.log('')
  printHistogram(hs)
}

async function main_amqplib() {
  const conn = await amqplib.connect(RABBITMQ_URL, {
    noDelay: NO_DELAY
  })
  // @ts-ignore
  conn.on('error', err => { console.error('connection error', err) })
  conn.on('blocked', () => { console.log('connection.blocked') })
  conn.on('unblocked', () => { console.log('connection.blocked') })
  const ch = await conn.createConfirmChannel()

  const hs = 'time per batch (milliseconds)'
  for (let i = 0; i < TOTAL; i+=BATCH_SIZE) {
    performance.mark('start:' + hs)
    for (let j = 0; j < BATCH_SIZE; ++j) {
      ch.publish('', ROUTING_KEY, PAYLOAD, {})
    }
    await ch.waitForConfirms()
    performance.mark('stop:' + hs)
  }

  await ch.close()
  await conn.close()

  console.log('')
  printHistogram(hs)
}
