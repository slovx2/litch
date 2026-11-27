import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessSubject, createScopedAccess } from '../src/deferred-access.mjs'

test('重试授权只覆盖发卡会话、执行的浏览器和目标；一次、限时、长期分别到期', () => {
  let now = 100_000
  const allowed = createScopedAccess(() => now)
  const site = { kind: 'site' as const, origin: 'https://one.example', url: 'https://one.example/' }
  const builtin = accessSubject(site, 'navigate', {})
  const chrome = accessSubject({ ...site, browser: 'chrome' }, 'navigate', {})
  const differentSite = accessSubject({ ...site, origin: 'https://other.example' }, 'navigate', {})
  assert.ok(builtin && chrome && differentSite)
  assert.equal(
    accessSubject({ kind: 'computerSelf', id: '1', nonce: '2', desktopId: null }, 'click', {}),
    null,
  )
  allowed.grant('device', 'first', builtin, null)
  assert.equal(allowed.use('device', 'second', builtin), false)
  assert.equal(allowed.use('different', 'first', builtin), false)
  assert.equal(allowed.use('device', 'first', chrome), false)
  assert.equal(allowed.use('device', 'first', builtin), true)
  assert.equal(allowed.use('device', 'first', builtin), false)
  allowed.grant('device', 'first', chrome, 2)
  assert.equal(allowed.use('device', 'first', chrome), true)
  now += 2 * 3_600_000
  assert.equal(allowed.use('device', 'first', chrome), false)
  allowed.grant('device', 'first', builtin, 'always')
  assert.equal(allowed.use('device', 'first', builtin), true)
  assert.equal(allowed.use('device', 'first', builtin), true)
  assert.equal(allowed.use('device', 'first', differentSite), false)
  allowed.clear('device', 'first')
  assert.equal(allowed.use('device', 'first', builtin), false)
})
