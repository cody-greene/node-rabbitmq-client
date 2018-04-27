'use strict'

/**
 * Double-ended Queue
 * L.........R
 * head...tail
 */
class Deque {
  constructor(src) {
    this.head = null
    this.tail = null
    this.size = 0
    if (src) for (let val of src) this.pushRight(val)
  }
  pushLeft(value) {
    let prev = this.head
    this.head = {val: value, _l: null, _r: prev}
    if (this.tail == null) this.tail = this.head
    else prev._l = this.head
    this.size += 1
  }
  popLeft() {
    let node = this.head
    if (node == null) {
      return null
    }
    this.head = node._r
    if (this.head == null) {
      this.tail = null
    }
    else {
      this.head._l = null
    }
    this.size -= 1
    return node.val
  }
  pushRight(value) {
    let prev = this.tail
    this.tail = {val: value, _l: prev, _r: null}
    if (this.head == null) this.head = this.tail
    else prev._r = this.tail
    this.size += 1
  }
  popRight() {
    let node = this.tail
    if (node == null) {
      return null
    }
    this.tail = node._l
    if (this.tail == null) {
      this.head = null
    }
    else {
      this.tail._r = null
    }
    this.size -= 1
    return node.val
  }
  peekRight() {
    return this.tail && this.tail.val
  }
  peekLeft() {
    return this.head && this.head.val
  }
  *valuesLeft() {
    let node
    while (node = this.popLeft()) {
      yield node
    }
  }
  *valuesRight() {
    let node
    while (node = this.popRight()) {
      yield node
    }
  }
  clear() {
    let items = new Array(this.size)
    let cur = this.head
    let index = 0
    while (cur) {
      items[index++] = cur.val
      cur = cur._r
    }
    this.head = null
    this.tail = null
    return items
  }
}

module.exports = Deque
