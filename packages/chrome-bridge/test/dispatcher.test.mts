import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientToolInvocation } from '../../browser/src/tool-port.mjs'
import { targetsChrome } from '../src/dispatcher.mjs'

test('新内置认领句柄显式分流；旧调用和 Chrome 句柄仍送原后端，失败不会换后端', () => {
  const route = (tool: string, args: unknown = {}) =>
    targetsChrome({ tool, arguments: args } as ClientToolInvocation)
  assert.equal(route('claim', { claimToken: 'builtin:opaque-token' }), false)
  assert.equal(route('ensure_claimed', { tabId: 't1' }), false)
  assert.equal(route('release', { tabId: 't1' }), false)
  for (const tool of ['claim', 'ensure_claimed', 'release', 'targets'])
    assert.equal(route(tool), true)
  assert.equal(route('claim', { claimToken: 'old-chrome-token' }), true)
  assert.equal(route('ensure_claimed', { tabId: 'chrome:old-tab' }), true)
  assert.equal(route('snapshot', { tabId: 'chrome:old-tab' }), true)
  assert.equal(route('snapshot', { tabId: 't1' }), false)
})
