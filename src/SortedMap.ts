class Node<K, V> {
  key: K
  value: V
  parent: Node<K, V>
  left: Node<K, V>
  right: Node<K, V>
  size: number

  /** The nil node (see the Null Object Pattern), used for leaf nodes or for
   * the parent of the root node. NIL nodes are immutable. This simplifies the
   * rebalancing algorithms. This will throw a TypeError if modifications are
   * attempted. */
  static NIL: Node<any, any> = Object.freeze(
    new class extends Node<unknown, unknown> {
      toString() { return '·' }
      constructor() {
        super(Symbol('nil'), Symbol('nil'))
        this.size = 0
        this.parent = this.left = this.right = this
      }
    }()
  )

  constructor(key: K, value: V) {
    this.key = key
    this.value = value
    this.parent = this.left = this.right = Node.NIL
    this.size = 1
  }
}

/** @internal Returns a negative number if a < b, a positive number if a > b, or 0 if a == b */
export type Comparator<V> = (a: V, b: V) => number

/**
 * Hirai, Y.; Yamamoto, K. (2011). "Balancing weight-balanced trees" (PDF).
 * Journal of Functional Programming. 21 (3): 287.
 * doi:10.1017/S0956796811000104.
 * https://yoichihirai.com/bst.pdf
 *
 * Delta decides whether any rotation is made at all
 */
const Δ = 3
/** Gamma chooses a single rotation or a double rotation. */
const Γ = 2

/**
 * Weight-Balanced Tree.
 * Insertion, deletion and iteration have O(log n) time complexity where n is
 * the number of entries in the tree. Items must have an absolute ordering.
 *
 * @internal
 */
export default class SortedMap<K, V> implements Map<K, V> {
  private _root: Node<K, V>
  private _compare: Comparator<K>

  /**
   * @param source An inital list of values
   * @param compare Sorting criterum: Should run in O(1) time
   */
  constructor(source?: Iterable<[K, V]>|null, compare: Comparator<K> = (a, b) => a === b ? 0 : a < b ? -1 : 1) {
    this._compare = compare
    this._root = Node.NIL
    if (source) for (const [key, val] of source)
      this._insertNode(new Node(key, val))
  }

  get size(): number { return this._root.size }

  get [Symbol.toStringTag]() { return 'SortedMap' }

  /** Traverse keys, breadth-first */
  *bfs() {
    if (this._root === Node.NIL) return
    let queue = [this._root]
    while (queue.length) {
      const next = queue.shift()!
      yield next.key
      if (next.left !== Node.NIL) queue.push(next.left)
      if (next.right !== Node.NIL) queue.push(next.right)
    }
  }

  toString(): string {
    return `[${this[Symbol.toStringTag]} size:${this.size}]`
  }

  has(key: K): boolean {
    return this._findNode(key) !== Node.NIL
  }

  get(key: K): V | undefined {
    const node = this._findNode(key)
    return node === Node.NIL ? undefined : node.value
  }

  set(key: K, value: V): this {
    this._insertNode(new Node(key, value))
    return this
  }

  delete(key: K): boolean {
    const node = this._findNode(key)
    const result = this._deleteNode(node)
    return result
  }

  clear(): void {
    this._root = Node.NIL
  }

  forEach(cb: (value1: V, value2: K, tree: Map<K, V>) => void, self?: any): void {
    for (const [key, val] of this.entries())
      cb.call(self, val, key, this)
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  values(): IterableIterator<V> {
    return this._iterator(node => node.value)
  }

  keys(): IterableIterator<K> {
    return this._iterator(node => node.key)
  }

  entries(): IterableIterator<[K, V]> {
    return this._iterator(node => [node.key, node.value])
  }

  /** Return a missing value from the set. If {4} then result = 3 so it's not
   * always the LOWEST missing number but that's not necessary here. */
  pick(min = 1): number {
    // n.b.
    // to find the LOWEST missing number in [min ... STORED_VALUES] (inclusive)
    // requires checking the value at rank 0 at the cost of an extra
    // ~O(log n) steps, or extra book-keeping to track the stored min value.
    if (this._root === Node.NIL) return min
    let dir = 0
    // FIXME Kind of a rude typecast, but this only works when K is a number.
    //       Maybe a subclass makes more sense.
    let node: Node<number, unknown> = this._root as Node<any, unknown>
    let parent = node
    do {
      dir = (node.left.size + min) - node.key
      parent = node
      if (dir < 0) {
        node = node.left
      } else {
        min += node.left.size + 1
        node = node.right
      }
    } while (node !== Node.NIL)
    return dir < 0 ? parent.key - 1 : parent.key + 1
  }

  private _iterator<R>(get: (node: Node<K, V>) => R): IterableIterator<R> {
    const tree = this
    let node = Node.NIL
    let started = false
    return {
      [Symbol.iterator]() { return this },
      next() {
        if (node === Node.NIL) node = tree._firstNode()
        if (started) node = tree._nextNode(node)
        started = true

        const done = node === Node.NIL
        const value = done ? undefined : get(node)
        return {done, value} as IteratorResult<R>
        //                     ^^^^^^^^^^^^^^^^^^^^
        // See https://github.com/Microsoft/TypeScript/issues/11375
      }
    }
  }

  private _firstNode(node: Node<K, V> = this._root): Node<K, V> {
    while (node.left !== Node.NIL) node = node.left
    return node
  }

  private _nextNode(node: Node<K, V>): Node<K, V> {
    if (node === Node.NIL) return node
    if (node.right !== Node.NIL) return this._firstNode(node.right)
    let parent = node.parent
    while (parent !== Node.NIL && node === parent.right) {
      node = parent
      parent = parent.parent
    }
    return parent
  }

  private _findNode(key: K, node: Node<K, V> = this._root): Node<K, V> {
    let dir: number
    while (node !== Node.NIL && (dir = this._compare(key, node.key))) {
      node = dir < 0 ? node.left : node.right
    }
    return node
  }

  private _leftRotate(node: Node<K, V>): Node<K, V> {
    // assert node !== Node.NIL
    // assert node.right !== Node.NIL
    const child = node.right
    node.right = child.left
    // don't attempt to modify NIL
    if (child.left !== Node.NIL) child.left.parent = node
    child.parent = node.parent
    if (node === this._root) this._root = child
    else if (node === node.parent.left) node.parent.left = child
    else node.parent.right = child
    node.parent = child
    child.left = node
    child.size = node.size
    node.size = node.left.size + node.right.size + 1
    return child
  }

  private _rightRotate(node: Node<K, V>): Node<K, V> {
    // assert node !== Node.NIL
    // assert node.left !== Node.NIL
    const child = node.left
    node.left = child.right
    // don't attempt to modify NIL
    if (child.right !== Node.NIL) child.right.parent = node
    child.parent = node.parent
    if (node === this._root) this._root = child
    else if (node === node.parent.left) node.parent.left = child
    else node.parent.right = child
    node.parent = child
    child.right = node
    child.size = node.size
    node.size = node.left.size + node.right.size + 1
    return child
  }

  private _isUnbalanced(a: Node<K, V>, b: Node<K, V>): boolean {
    return Δ * (a.size + 1) < b.size + 1
  }

  private _isSingle(a: Node<K, V>, b: Node<K, V>): boolean {
    return a.size + 1 < Γ * (b.size + 1)
  }

  private _insertNode(node: Node<K, V>) {
    // assert node !== Node.NIL
    if (this._root === Node.NIL) {
      this._root = node
      return
    }

    let parent = Node.NIL
    let root = this._root
    let dir: number

    // find insertion point
    do {
      dir = this._compare(node.key, root.key)
      if (dir === 0) {
        return // element is already in the tree!
      }
      parent = root
      root = dir < 0 ? root.left : root.right
    } while (root !== Node.NIL)

    // replace leaf
    node.parent = parent
    if (dir < 0) parent.left = node
    else parent.right = node

    // walk back down the tree and rebalance
    do {
      parent.size += 1
      if (parent.right === node) {
        if (this._isUnbalanced(parent.left, parent.right)) {
          if (this._isSingle(parent.right.left, parent.right.right)) {
            parent = this._leftRotate(parent)
          } else {
            this._rightRotate(parent.right)
            parent = this._leftRotate(parent)
          }
        }
      } else {
        if (this._isUnbalanced(parent.right, parent.left)) {
          if (this._isSingle(parent.left.right, parent.left.left)) {
            parent = this._rightRotate(parent)
          } else {
            this._leftRotate(parent.left)
            parent = this._rightRotate(parent)
          }
        }
      }

      node = parent
      parent = parent.parent
    } while (parent !== Node.NIL)

    // in case the root node was rotated away
    this._root = node
  }

  private _deleteNode(node: Node<K, V>): boolean {
    if (node === Node.NIL) return false

    let child: Node<K, V>
    let parent: Node<K, V>
    if (node.left !== Node.NIL && node.right !== Node.NIL) {
      // find the first child with a NIL left-pointer (in the right-hand tree)
      // this will replace the deleted node
      let next = node.right
      while (next.left !== Node.NIL) next = next.left

      next.left = node.left
      next.left.parent = next
      if (node === this._root) this._root = next
      else if (node === node.parent.left) node.parent.left = next
      else node.parent.right = next
      child = next.right // may be NIL
      parent = next.parent
      if (node === parent) parent = next
      else {
        if (child !== Node.NIL) child.parent = parent
        parent.left = child
        next.right = node.right
        node.right.parent = next
      }
      next.parent = node.parent
    } else {
      child = node.left === Node.NIL ? node.right : node.left // may be NIL
      parent = node.parent // may be NIL
      if (child !== Node.NIL) child.parent = parent
      if (node === this._root) this._root = child
      else if (parent.left === node) parent.left = child
      else parent.right = child
    }

    node = child
    while (parent !== Node.NIL) {
      parent.size = parent.left.size + parent.right.size + 1
      // left rotation is performed when an element is deleted from the left subtree
      if (parent.left === node) {
        if (this._isUnbalanced(parent.left, parent.right)) {
          if (this._isSingle(parent.right.left, parent.right.right)) {
            parent = this._leftRotate(parent)
          } else {
            this._rightRotate(parent.right)
            parent = this._leftRotate(parent)
          }
        }
      } else {
        if (this._isUnbalanced(parent.right, parent.left)) {
          if (this._isSingle(parent.left.right, parent.left.left)) {
            parent = this._rightRotate(parent)
          } else {
            this._leftRotate(parent.left)
            parent = this._rightRotate(parent)
          }
        }
      }

      node = parent
      parent = parent.parent
    }

    // in case the root node was rotated away
    this._root = node

    return true
  }
}
