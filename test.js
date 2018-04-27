'use strict'

const codec = require('./lib/codec')
const bytes = Buffer.from("01000100000032003c003c1f616d712e637461672d4e4143585a703564756c47545342664852646b2d33510000000000000001000003666f6fce02000100000013003c0000000000000000001830000000000001ce030001000000187b226d657373616765223a2248656c6c6f20616d7170227dce", 'hex')

let evt, data

;[evt, data] = codec.decodeFrame(bytes)
console.log(evt)
;[evt, data] = codec.decodeFrame(data)
console.log(evt)
;[evt, data] = codec.decodeFrame(data)
console.log(evt)

console.log(data)
