import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Clipboard from 'expo-clipboard'
import { reportTestClipboard } from '../src/shell/test-clipboard.ts'

test('剪贴板探针只报告原生读回，不用期望值伪造；请求标识逐次回传', async (t) => {
  const original = globalThis.fetch
  const sent = []
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (url, options) => {
    sent.push({ url, result: JSON.parse(options.body) })
    return { ok: true }
  }
  await reportTestClipboard(new URLSearchParams('action=seed&port=12345&id=before'))
  assert.equal(sent[0].result.text, 'e2e-clipboard-sentinel')
  await Clipboard.setStringAsync('actual native value\n第二行')
  await reportTestClipboard(new URLSearchParams('action=read&port=12345&id=after'))
  assert.equal(sent[1].result.text, 'actual native value\n第二行')
  assert.equal(sent[1].url, 'http://127.0.0.1:12345/clipboard/result?id=after')
  await reportTestClipboard(new URLSearchParams('action=read&port=https://example.com&id=no'))
  await reportTestClipboard(new URLSearchParams('action=write&port=12345&id=no'))
  assert.equal(sent.length, 2)
})
