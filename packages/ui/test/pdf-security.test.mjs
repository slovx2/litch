import assert from 'node:assert/strict'
import test from 'node:test'
import { uiResourcePolicy } from '../../../apps/desktop/src/ui-security.mts'

test('PDF Worker 开发/正式响应策略一致，主文档不允许 WASM 或开发网络', () => {
  const worker = uiResourcePolicy('/assets/pdf-worker-aBc123.js')
  assert.equal(uiResourcePolicy('/src/files/preview/pdf/pdf-worker.ts'), worker)
  assert(worker.includes("script-src 'wasm-unsafe-eval'"))
  assert(!worker.includes("'self'"))
  for (const path of [
    '/index.html',
    '/assets/highlight.worker-a.js',
    '/assets/office.worker-b.js',
  ]) {
    const policy = uiResourcePolicy(path)
    assert(policy.includes("connect-src 'none'"))
    assert(policy.includes("worker-src 'self'"))
    assert(!/wasm-unsafe-eval|unsafe-inline|http:|ws:|blob:/.test(policy))
  }
})
