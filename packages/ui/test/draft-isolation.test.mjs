// 对应 compose 的切走/切回草稿断言；另保留窗口上的输入焦点、粘贴与缩略图验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dropDraft,
  loadDraft,
  loadDraftExtras,
  loadDraftImages,
  saveDraft,
  saveDraftExtras,
  saveDraftImages,
} from '../src/composer/drafts.ts'
import {
  keepQuestionDrafts,
  loadQuestionDraft,
  saveQuestionDraft,
} from '../src/composer/question-drafts.ts'

test('文字、图片、附带项按设备和会话隔离；清空一个不影响另一个', () => {
  const first = 'device-a:compose-main'
  const other = 'device-a:compose-other'
  const remote = 'device-b:compose-main'
  const image = { mimeType: 'image/png', data: 'AAAA', name: '草稿.png' }
  const extra = { kind: 'text', label: '说明', text: '未发送的补充' }
  saveDraft(first, '写了一半的草稿')
  saveDraftImages(first, [image])
  saveDraftExtras(first, [extra])
  for (const key of [other, remote]) {
    assert.equal(loadDraft(key), '')
    assert.deepEqual(loadDraftImages(key), [])
    assert.deepEqual(loadDraftExtras(key), [])
  }
  saveDraft(other, '另一个会话的话')
  saveDraft(remote, '另一台设备的话')
  assert.equal(loadDraft(first), '写了一半的草稿')
  assert.deepEqual(loadDraftImages(first), [image])
  assert.deepEqual(loadDraftExtras(first), [extra])
  dropDraft(first)
  saveDraftImages(first, [])
  saveDraftExtras(first, [])
  assert.equal(loadDraft(other), '另一个会话的话')
  assert.equal(loadDraft(remote), '另一台设备的话')
})

test('提问切走再回来保留页码和已答内容，仅清理已经结束的请求', () => {
  const ref = { deviceId: 'a', sessionId: 'same', requestId: 'question' }
  const draft = {
    page: 1,
    entries: {
      first: { kind: 'option', label: '第一项' },
      second: { kind: 'other', text: '写到一半' },
    },
  }
  saveQuestionDraft(ref, draft)
  assert.equal(loadQuestionDraft({ ...ref, sessionId: 'other' }), undefined)
  assert.equal(loadQuestionDraft({ ...ref, deviceId: 'b' }), undefined)
  keepQuestionDrafts('a', 'other', [])
  keepQuestionDrafts('a', 'same', ['question'])
  assert.deepEqual(loadQuestionDraft(ref), draft)
  keepQuestionDrafts('a', 'same', [])
  assert.equal(loadQuestionDraft(ref), undefined)
})
