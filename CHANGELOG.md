# v3.1.0
- add Connection.createRPClient() for easy RPC/request-response setup
- fix header array encode/decode e.g. CC/BCC "Sender-selected Distribution"
- adjust some HeaderFields typedefs
- allow numbers in certain cases where a string is expected by the AMQP protocol, e.g. the "expiration" header prop; the value is trivially converted
- fix array encode/decode for message headers in the rare cases it's actually used
- reconnection backoff is a little more random
