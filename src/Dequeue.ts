interface Node<T> {
  val: undefined|T;
  _l: null|Node<T>;
  _r: null|Node<T>;
}

/**
 * Double-ended Queue
 * L.........R
 * head...tail
 * @internal
 */
export default class Dequeue<T> {
  private head: null|Node<T>
  private tail: null|Node<T>
  size: number
  constructor(src: T[]) {
    this.head = null
    this.tail = null
    this.size = 0
    if (src) for (let val of src) this.pushRight(val)
  }
  pushLeft(value: T) {
    let prev = this.head
    this.head = {val: value, _l: null, _r: prev}
    if (this.tail == null) this.tail = this.head
    if (prev) prev._l = this.head
    this.size += 1
  }
  popLeft(): undefined|T {
    let node = this.head
    if (node == null) {
      return
    }
    this.head = node._r
    if (this.head == null) {
      this.tail = null
    } else {
      this.head._l = null
    }
    this.size -= 1
    return node.val
  }
  pushRight(value: T) {
    let prev = this.tail
    this.tail = {val: value, _l: prev, _r: null}
    if (this.head == null) this.head = this.tail
    if (prev) prev._r = this.tail
    this.size += 1
  }
  popRight(): undefined|T {
    let node = this.tail
    if (node == null) {
      return
    }
    this.tail = node._l
    if (this.tail == null) {
      this.head = null
    } else {
      this.tail._r = null
    }
    this.size -= 1
    return node.val
  }
  peekRight(): undefined|T {
    if (this.tail)
      return this.tail.val
  }
  peekLeft(): undefined|T {
    if (this.head)
      return this.head.val
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
  clear(): T[] {
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
  remove(el: T): undefined|T {
    let cur = this.head
    let prv = null
    while (cur) {
      if (cur.val === el) {
        if (prv) {
          prv._r = cur._r
        }
        if (cur._r) {
          cur._r._l = prv
        }
        return el
      }
      prv = cur
      cur = cur._r
    }
    return
  }
}
