import assert from 'node:assert/strict'
import test from 'node:test'
import { ThreadSubscribers } from '../src/thread-subscribers.mjs'
import type { RpcPeer } from '../src/types.mjs'

const peer = (id: string): RpcPeer => ({ id, send: () => {}, close: () => {} })

test('会话的订阅连接是一个集合：按订阅先后排列，重复订阅不变，退订和断开只摘掉自己', () => {
  const subscribers = new ThreadSubscribers()
  const first = peer('first')
  const second = peer('second')
  assert.equal(subscribers.has('a'), false)
  assert.equal(subscribers.first('a'), undefined)

  subscribers.add('a', first)
  subscribers.add('a', second)
  subscribers.add('a', first)
  subscribers.add('b', second)
  assert.deepEqual(subscribers.list('a'), [first, second])
  assert.equal(subscribers.first('a'), first)
  assert.deepEqual(subscribers.threads(), ['a', 'b'])
  assert.deepEqual(subscribers.threadsOf(second), ['a', 'b'])

  assert.equal(subscribers.remove('a', first), true)
  assert.equal(subscribers.remove('a', first), false, '没订阅着的退订不算')
  assert.deepEqual(subscribers.list('a'), [second])

  subscribers.removePeer(second)
  assert.deepEqual(subscribers.threads(), [], '一条订阅连接都没有的会话不算已加载')
  assert.equal(subscribers.has('a'), false)
})

test('会话重新有人订阅时排到最后；清空返回原来的订阅连接', () => {
  const subscribers = new ThreadSubscribers()
  const first = peer('first')
  const second = peer('second')
  subscribers.add('a', first)
  subscribers.add('b', first)
  subscribers.remove('a', first)
  subscribers.add('a', second)
  assert.deepEqual(subscribers.threads(), ['b', 'a'])
  assert.deepEqual(subscribers.clear('a'), [second])
  assert.deepEqual(subscribers.clear('a'), [])
  assert.deepEqual(subscribers.threads(), ['b'])
})
