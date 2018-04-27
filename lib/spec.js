'use strict'

module.exports = transformDefs(require('./amqp-rabbitmq-0.9.1.json'))

function transformDefs(src) {
  let domains = new Map(src.domains)
  let classes = new Map()
  for (let index = 0; index < src.classes.length; index++) {
    let item = src.classes[index]
    item = {
      id: item.id,
      name: item.name,
      properties: item.properties,
      methods: transformMethods(item.methods, domains)
    }
    classes.set(item.id, item).set(item.name, item)
  }
  let headers = transformContentHeaders(classes.get('basic').properties)
  let res = {classes, headers}
  transformConstants(src, res)
  return res
}

function transformConstants(src, dest) {
  let statusCodes = new Map()
  for (let index = 0; index < src.constants.length; index++) {
    let item = src.constants[index]
    if (item.class) {
      statusCodes.set(item.value, item.name.replace(/-/g, '_'))
    }
    else {
      // regular constant
      dest[item.name.replace(/-/g, '_')] = item.value
    }
  }
  dest.VERSION = [0, src['major-version'], src['minor-version'], src.revision]
  dest.statusCodes = statusCodes
  return dest
}

function transformMethods(items, domains) {
  let methods = new Map()
  for (let index = 0; index < items.length; index++) {
    let item = items[index]
    item = {
      id: item.id,
      name: item.name,
      synchronous: item.synchronous,
      params: transformArguments(item.arguments, domains)
    }
    methods.set(item.id, item).set(item.name, item)
  }
  return methods
}

function transformArguments(items, domains) {
  let params = new Array(items.length)
  for (let index = 0; index < items.length; index++) {
    let item = items[index]
    params[index] = {
      name: item.name,
      alias: toCamelCase(item.name),
      type: item.type || domains.get(item.domain),
      defaultValue: item['default-value']
    }
  }
  return params
}

function toCamelCase(str) {
  return str.replace(/-(.)/g, (_, $1) => $1.toUpperCase())
}

function transformContentHeaders(list) {
  for (let prop of list) {
    prop.alias = toCamelCase(prop.name)
  }
  return list
}
