import test from 'tape'
import SortedMap from '../src/SortedMap'

function toSortedMap(keys: number[]): SortedMap<number, unknown> {
  return new SortedMap(keys.map(k => [k, null]))
}
function toString(sm: SortedMap<number, unknown>): string {
  return Array.from(sm.bfs()).join()
}

test('SortedMap delete easy', (t) => {
  const sm = toSortedMap([3,2,1])
  sm.delete(3)
  t.equal(toString(sm), '2,1')
  t.end()
})

test('SortedMap delete pull-right-left', (t) => {
  const sm = toSortedMap([2,1,4,3])
  sm.delete(2)
  t.equal(toString(sm), '3,1,4')
  t.end()
})

test('SortedMap delete pull-right-left-deep', (t) => {
  const sm = toSortedMap([2,1,5,4,3])
  sm.delete(2)
  t.equal(toString(sm), '3,1,5,4')
  t.end()
})

test('SortedMap delete pull-right-rot-right', (t) => {
  const sm = toSortedMap([5,3,6,2,4])
  sm.delete(5)
  // 6,3,2,4 +rebalance (rotate right)
  t.equal(toString(sm), '3,2,6,4')
  t.end()
})
