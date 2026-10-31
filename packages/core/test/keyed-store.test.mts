import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedStore } from '../src/replica/keyed-store.mjs'

test('清理大会话：多键订阅只读取一次完整清理后的状态', () => {
  const store = new KeyedStore()
  const keys = Array.from({ length: 4_000 }, (_, i) => `session:large:item:${i}`)
  for (const key of keys) store.set(key, key)
  store.set('session:other:item:1', '保留')
  let reads = 0
  let notifications = 0
  let remaining = -1
  // 后台任务面板会同时订阅历史条目，每次通知重新读取这些键。
  const listener = () => {
    notifications++
    remaining = keys.filter((key) => {
      reads++
      return store.get(key) !== undefined
    }).length
  }
  for (const key of keys) store.subscribe(key, listener)
  store.deletePrefix('session:large:')
  assert.equal(notifications, 1)
  assert.equal(reads, keys.length)
  assert.equal(remaining, 0)
  assert.equal(store.get('session:other:item:1'), '保留')
})

test('嵌套批处理：同一订阅者只看到最终值，独立订阅者各通知一次', () => {
  const store = new KeyedStore()
  const seen: unknown[][] = []
  const shared = () => seen.push([store.get('a'), store.get('b')])
  store.subscribe('a', shared)
  store.subscribe('b', shared)
  let individual = 0
  store.subscribe('b', () => individual++)
  store.batch(() => {
    store.set('a', 1)
    store.batch(() => {
      store.set('b', 2)
      store.set('a', 3)
    })
    assert.equal(seen.length, 0)
  })
  assert.deepEqual(seen, [[3, 2]])
  assert.equal(individual, 1)
})

test('批外仍即时通知，退订与通知中写入其他键不丢更新', () => {
  const store = new KeyedStore()
  const seen: unknown[] = []
  const stop = store.subscribe('a', () => store.set('b', store.get('a')))
  store.subscribe('b', () => seen.push(store.get('b')))
  store.set('a', 1)
  assert.deepEqual(seen, [1])
  store.set('a', 1)
  assert.deepEqual(seen, [1])
  stop()
  store.set('a', 2)
  assert.deepEqual(seen, [1])
  store.deletePrefix('missing:')
  assert.deepEqual(seen, [1])
})
