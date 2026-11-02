// 新建会话页上剩下的草稿挪进新会话的输入框（src/composer/drafts.ts 的 moveDraft）：
// 文字、图片、附带项、评论片整份带过去，原处清空；没有剩下的什么都不动。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  loadDraft,
  loadDraftComments,
  loadDraftExtras,
  loadDraftImages,
  moveDraft,
  saveDraft,
  saveDraftComments,
  saveDraftExtras,
  saveDraftImages,
} = await import('../src/composer/drafts.ts')

const image = { mimeType: 'image/png', data: 'AAAA', name: 'a.png' }
const extra = { kind: 'text', label: 'log.txt', text: '一段日志' }
const comment = { id: 'c1', quote: '原文', note: '评论', turnId: 't1', itemId: 'i1' }

test('剩下的文字、图片、附带项、评论片整份挪过去，新建页清空', () => {
  saveDraft('new', '第二句')
  saveDraftImages('new', [image])
  saveDraftExtras('new', [extra])
  saveDraftComments('new', [comment])
  moveDraft('new', 'local:s1')
  assert.equal(loadDraft('local:s1'), '第二句')
  assert.deepEqual(loadDraftImages('local:s1'), [image])
  assert.deepEqual(loadDraftExtras('local:s1'), [extra])
  assert.deepEqual(loadDraftComments('local:s1'), [comment])
  assert.equal(loadDraft('new'), '')
  assert.deepEqual(loadDraftImages('new'), [])
  assert.deepEqual(loadDraftExtras('new'), [])
  assert.deepEqual(loadDraftComments('new'), [])
})

test('新建页什么都没剩：目标原有的草稿不动', () => {
  saveDraft('local:s2', '原来写的')
  moveDraft('new', 'local:s2')
  assert.equal(loadDraft('local:s2'), '原来写的')
  assert.deepEqual(loadDraftImages('local:s2'), [])
})
