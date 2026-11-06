import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConsentHosts } from '../src/privacy/consent-hosts.ts'

test('同意框优先交给最上层抽屉，关闭或卸载后回到仍在展示的承载点', () => {
  const hosts = createConsentHosts()
  const seen = []
  const stop = hosts.subscribe(() => seen.push(hosts.current()))
  assert.equal(hosts.current(), null)
  const closeFirst = hosts.register('first')
  const closeSecond = hosts.register('second')
  assert.equal(hosts.current(), 'second')
  closeSecond()
  assert.equal(hosts.current(), 'first')
  closeFirst()
  assert.equal(hosts.current(), null)
  assert.deepEqual(seen, ['first', 'second', 'first', null])
  stop()
})

test('旧注册的清理不能撤掉同名新承载点，下层卸载不抢上层同意框', () => {
  const hosts = createConsentHosts()
  const old = hosts.register('drawer')
  const current = hosts.register('drawer')
  old()
  assert.equal(hosts.current(), 'drawer')
  const nested = hosts.register('nested')
  current()
  assert.equal(hosts.current(), 'nested')
  nested()
  assert.equal(hosts.current(), null)
})
