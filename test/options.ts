import test from 'tape'
import normalizeOptions from '../src/normalize'

test('should enable TLS and change the default port for "amqps" urls', async (t) => {
  const a1 = normalizeOptions('amqps://guest:guest@127.0.0.1')
  t.ok(a1.tls)
  t.equal(a1.hosts[0].port, '5671')

  const a2 = normalizeOptions('amqps://guest:guest@127.0.0.1:1234')
  t.ok(a2.tls)
  t.equal(a2.hosts[0].port, '1234')

  const a3 = normalizeOptions('amqp://guest:guest@127.0.0.1')
  t.ok(!a3.tls)
  t.equal(a3.hosts[0].port, '5672')

  const a4 = normalizeOptions('amqp://guest:guest@127.0.0.1:1234')
  t.ok(!a4.tls)
  t.equal(a4.hosts[0].port, '1234')
})
