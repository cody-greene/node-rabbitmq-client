# v4.2.1
fix: closing a channel (in a certain order) no longer causes a lockup

# v4.2.0
- [#29](https://github.com/cody-greene/node-rabbitmq-client/pull/29) Added some management methods to the top-level Connection interface. You can create/delete queues, exchanges, and bindings. A special channel is implicitly created and maintained internally, so you don't have to worry about it. New methods:
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
