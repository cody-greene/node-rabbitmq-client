import test from 'node:test'
import assert from 'node:assert/strict'
import normalizeOptions from '../src/normalize'

test('should enable TLS and change the default port for "amqps" urls', async () => {
  const a1 = normalizeOptions('amqps://guest:guest@127.0.0.1')
  assert.ok(a1.tls)
  assert.equal(a1.hosts[0].port, '5671')

  const a2 = normalizeOptions('amqps://guest:guest@127.0.0.1:1234')
  assert.ok(a2.tls)
  assert.equal(a2.hosts[0].port, '1234')

  const a3 = normalizeOptions('amqp://guest:guest@127.0.0.1')
  assert.ok(!a3.tls)
  assert.equal(a3.hosts[0].port, '5672')

  const a4 = normalizeOptions('amqp://guest:guest@127.0.0.1:1234')
  assert.ok(!a4.tls)
  assert.equal(a4.hosts[0].port, '1234')
})
