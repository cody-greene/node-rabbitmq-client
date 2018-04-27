# Synchronous methods
'access.request'
'basic.cancel'
'basic.consume'
'basic.get'
'basic.qos'
'basic.recover'
'channel.close'
'channel.flow'
'channel.open'
'confirm.select'
'connection.close'
'connection.open'
'exchange.bind'
'exchange.declare'
'exchange.delete'
'exchange.unbind'
'queue.bind'
'queue.declare'
'queue.delete'
'queue.purge'
'queue.unbind'
'tx.commit'
'tx.rollback'
'tx.select'

# Async methods
'basic.ack'
'basic.deliver'
'basic.get-empty'
'basic.nack'
'basic.publish'
'basic.recover-async'
'basic.reject'
'basic.return'
'connection.blocked'
'connection.unblocked'

# Synchronous Response only
'connection.secure-ok'
'connection.start-ok'
'connection.tune-ok'

# Content Properties
- contentType
- contentEncoding
- headers
- deliveryMode
- priority
- expiration
- messageId
- timestamp
- type

# TODO parse header-body frames for:
- basic.return
- basic.deliver
- basic.get-ok (sync)

i.e. where methodDef.content === true
methodDef = spec.classes.get('basic').methods.get(...)

# TODO recieve basic.cancel
- queue was deleted

# TODO basic.get
can recieve basic.get-ok OR basic.get-empty
