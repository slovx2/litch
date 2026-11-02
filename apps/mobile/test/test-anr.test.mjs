import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleDevLink, navigationRef } from '../src/shell/dev-links.ts'
import { natives } from './stubs/expo-modules-core.mjs'

test('ANR 注入只认当前 mock/fixture 核心；正式模式不能被链接参数绕过', () => {
  const calls = []
  natives.LitchTestControl = { blockMainThread: (mode) => calls.push(mode) }
  navigationRef.isReady = () => true
  for (const mode of ['stored', 'mock', 'fixture']) {
    handleDevLink('litch://test-anr?mode=mock', { booted: { mode } })
  }
  assert.deepEqual(calls, ['mock', 'fixture'])
  delete natives.LitchTestControl
})
