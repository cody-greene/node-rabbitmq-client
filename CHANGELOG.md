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
