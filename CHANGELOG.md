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
