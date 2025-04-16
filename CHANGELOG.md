## v5.0.3
### Bug Fixes
- cc03881 fix: 4.1 frame size updates (#75)

## v5.0.2
### Bug Fixes
- fix channel setup race

## v5.0.1
### Bug Fixes
- 38c61f5 lazy channel should not get perma-stuck

## v5.0.0
### BREAKING CHANGES:
#### 6766969 drop support for node 16
Node 16 hit end-of-life on 2023-09-11. Typescript compiler target has been
updated accordingly.

#### 8000e78 rm publisher.publish()
This method was just an alias for `send()` and has been deprecated for quite a
while. To migrate just find & replace.

#### 3bbfc87 consumer reply forces exchange=""
See discussion in https://github.com/cody-greene/node-rabbitmq-client/issues/42

The reply function provided to consumer handlers now forces the
`exchange` argument to an empty string.

If you want to publish to a different exchange, then use a dedicated publisher.
This is already the default behavior so unless you're using
`reply(msg, {exchange: 'whatever'})` you don't have to change anything.

```javascript
const pub = rabbit.createPublisher()

const sub = rabbit.createConsumer({queue: 'myqueue'}, async (msg, reply) => {
  reply('my response') // GOOD
  reply('my response', {exchange: 'other'}) // BAD
  await pub.send({exchange: 'other'}, 'my response') // GOOD
})
```

### Features
- a866874 (#58) `connection.onConnect()` Returns a promise which is resolved when the
  connection is established

## v4.6.0

### Features
- Add lazy consumer options (#51): Start or restart a consumer with `sub.start()`

## v4.5.4

### Bug Fixes
- silence MaxListenersExceededWarning with >10 channels

## v4.5.3

### Bug Fixes
- experimental bun support

## v4.5.2

### Bug Fixes
- aws-lambda, send() won't hang after reconnect (#46)

## v4.5.1

### Bug Fixes
- Check frame size before socket write (#41)

# v4.5.0
Features:
- You can now override the exchange and correlationId when replying to a
  consumed message with `reply()` (for messages with a replyTo header)

# v4.4.0
Features:
- added a boolean getter, `connection.ready`: True if the connection is
  established and unblocked. Useful for healthchecks and the like.

# v4.3.0
Features:
- Consumers now track some simple statistics: total messages
  acknowledged/requeued/dropped, and the current number of prefetched messages.
  Find these values in the `consumer.stats` object.

# v4.2.1
fix: closing a channel (in a certain order) no longer causes a lockup

# v4.2.0
[#29](https://github.com/cody-greene/node-rabbitmq-client/pull/29) Added some
management methods to the top-level Connection interface. You can create/delete
queues, exchanges, and bindings. A special channel is implicitly created and
maintained internally, so you don't have to worry about it. New methods:
- basicGet
- exchangeBind
- exchangeDeclare
- exchangeDelete
- exchangeUnbind
- queueBind
- queueDeclare
- queueDelete
- queuePurge
- queueUnbind

# v4.1.0
- feat: Consumer return code [#21](https://github.com/cody-greene/node-rabbitmq-client/pull/21)

# v4.0.0
BREAKING CHANGES:
- dropped node 14 (EOL 2023-04-30)
- `MethodParams` is indexed by an enum rather than a string, e.g.
  `MethodParams['basic.ack'] -> MethodParams[Cmd.BasicAck]`
- removed `nowait` from type definitions
- fixed typo on exported type def: RPCCLient -> RPCClient

Features:
- Rename `Publisher.publish() -> .send()` and `RPCClient.publish() -> .send()`
  the old method still exists as an alias, for now (deprecated)
- Added a few method overloads for: basicPublish, basicCancel, queueDeclare,
  queueDelete, queuePurge
- Documentation improvements: more examples, clarifications
- RPCClient supports retries `new RPCClient({maxAttempts: 2})`
- Better stack traces. When `Publisher#send()` fails, due to an undeclared
  exchange for example, the stack trace now includes your application code,
  rather than the async internals of this library.

# v3.3.2
- fix: better heartbeats [#13](https://github.com/cody-greene/node-rabbitmq-client/pull/13)

# v3.3.1
- fix: out-of-order RPCs [#10](https://github.com/cody-greene/node-rabbitmq-client/pull/10)

# v3.3.0
- feat: expose Consumer.queue & Consumer.consumerTag fields
- feat: add consumer concurrency limits [#6](https://github.com/cody-greene/node-rabbitmq-client/pull/6)

# v3.2.0
- feat: add Publisher maxAttempts [#5](https://github.com/cody-greene/node-rabbitmq-client/pull/5)

# v3.1.3
- improved error message when user/passwd is incorrect, i.e. ACCESS_REFUSED

# v3.1.1
- Consumer setup waits for in-progress jobs to complete before retrying
- add "x-cancel-on-ha-failover" typedef

# v3.1.0
- add Connection.createRPClient() for easy RPC/request-response setup
- fix header array encode/decode e.g. CC/BCC "Sender-selected Distribution"
- adjust some HeaderFields typedefs
- allow numbers in certain cases where a string is expected by the AMQP protocol, e.g. the "expiration" header prop; the value is trivially converted
- fix array encode/decode for message headers in the rare cases it's actually used
- reconnection backoff is a little more random
