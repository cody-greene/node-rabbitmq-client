#!/usr/bin/env node
'use strict'

const codec = require('./lib/codec')
const argv = process.argv.slice(2)

let [evt] = codec.parseFrame(Buffer.from(argv[0], 'base64'))

if (evt.type === 'method')
  console.log(`${evt.channel}:${evt.className}.${evt.methodName}`, evt.params)
else
  console.log(evt)
