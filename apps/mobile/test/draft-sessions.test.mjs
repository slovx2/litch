// 手机草稿里打 @ 提到的会话：随文字写进文件，杀掉应用重开后输入框里还是片；删草稿后不留。
import assert from 'node:assert/strict'
import test from 'node:test'
import { files } from './stubs/expo-file-system.mjs'

test('提到的会话重开还原，删草稿后清掉', async () => {
  files.clear()
  const key = 'device\nthread'
  const one = {
    kind: 'session',
    threadId: 't1',
    title: 'Grok Bot 实测：主动性、例程、通知机制调研',
  }
  const first = await import('../src/detail/composer/drafts.ts?sessions=first')
  first.saveDraft(key, `参考 @[${one.title}]`)
  first.saveDraftSessions(key, [one])
  first.flushDrafts()
  const reopened = await import('../src/detail/composer/drafts.ts?sessions=reopened')
  assert.equal(reopened.loadDraft(key), `参考 @[${one.title}]`)
  assert.deepEqual(reopened.loadDraftSessions(key), [one])
  reopened.dropDraft(key)
  reopened.flushDrafts()
  const again = await import('../src/detail/composer/drafts.ts?sessions=again')
  assert.deepEqual(again.loadDraftSessions(key), [])
})
