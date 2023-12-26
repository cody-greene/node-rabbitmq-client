// node -r ts-node/register/transpile-only benchmark.ts
/* eslint no-console: off */
import {randomBytes} from 'node:crypto'

// @ts-ignore
import amqplib from 'amqplib' // npm install --no-save amqplib
import {Bench} from 'tinybench'

import {Connection} from './lib'

declare global {
  namespace NodeJS {
    export interface ProcessEnv {
      MODULE?: 'rabbitmq-client' | 'amqplib'
      RABBITMQ_URL?: string | undefined
      /** Disable Nagle's algorithm (send tcp packets immediately) */
      NO_DELAY?: 'true'|'false'
    }
  }
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || ''
if (!RABBITMQ_URL)
  throw new TypeError('RABBITMQ_URL is unset')
const NO_DELAY = process.env.RABBITMQ_NO_DELAY === 'true'
const TRANSIENT_QUEUE = process.env.TRANSIENT_QUEUE || 'perf_' + randomBytes(8).toString('hex')
const NULL_ROUTE = process.env.TRANSIENT_QUEUE || 'perf_' + randomBytes(8).toString('hex')

const PAYLOAD = Buffer.from('prometheus')

console.log(`
NO_DELAY=${NO_DELAY}
TRANSIENT_QUEUE=${TRANSIENT_QUEUE}
NULL_ROUTE=${NULL_ROUTE}
`)

async function addRMQC(bench: Bench, rabbit: Connection, routingKey: string) {
  const pub = await rabbit.acquire()
  await pub.confirmSelect()
  bench.add(`rabbitmq-client publish-confirm (${routingKey})`, () => {
    return pub.basicPublish(routingKey, PAYLOAD)
  }, {
    afterAll() {
      pub.close()
    }
  })
}

async function benchAMQPLIB(bench: Bench, conn: any, routingKey: string) {
  const ch = await conn.createConfirmChannel()
  bench.add(`amqplib publish-confirm (${routingKey})`, async () => {
    ch.publish('', routingKey, PAYLOAD, {})
    return ch.waitForConfirms()
  }, {
    afterAll() {
      ch.close()
    }
  })
}

async function main() {
  const bench = new Bench()

  const rabbit = new Connection({
    url: RABBITMQ_URL,
    noDelay: NO_DELAY
  })
  rabbit.on('error', err => { console.error('connection error', err) })
  rabbit.on('connection.blocked', () => { console.error('connection.blocked') })
  rabbit.on('connection.unblocked', () => { console.error('connection.unblocked') })

  const conn = await amqplib.connect(RABBITMQ_URL, {
    noDelay: NO_DELAY
  })
  // @ts-ignore
  conn.on('error', err => { console.error('connection error', err) })
  conn.on('blocked', () => { console.log('connection.blocked') })
  conn.on('unblocked', () => { console.log('connection.blocked') })

  await addRMQC(bench, rabbit, NULL_ROUTE)
  await benchAMQPLIB(bench, conn, NULL_ROUTE)

  await rabbit.queueDeclare(TRANSIENT_QUEUE)
  await addRMQC(bench, rabbit, TRANSIENT_QUEUE)
  await benchAMQPLIB(bench, conn, TRANSIENT_QUEUE)
  await rabbit.queueDelete(TRANSIENT_QUEUE)

  await bench.run()

  await rabbit.close()
  await conn.close()

  console.table(bench.table())
}

main()
