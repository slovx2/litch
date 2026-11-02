import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { refreshAnswerDrafts } from '../src/manager/drafts.ts'
import {
  hasTemporaryQuestions,
  postCollapsed,
  postSummary,
  postViewKey,
  questionMode,
  rememberPostCollapsed,
  submitQuestionOnEnter,
} from '../src/manager/post-presentation.ts'

test('看板边界选对话字号，所有经理样式在使用处计算倍率', () => {
  const css = readFileSync(new URL('../src/styles/manager.css', import.meta.url), 'utf8')
  assert.match(
    css,
    /\.mg-board\s*\{\s*--fs: var\(--fs-chat\);\s*font-size: calc\(13px \* var\(--fs\)\);/,
  )
  assert.doesNotMatch(css, /font-size:\s*\d+(?:\.\d+)?px/)
})
test('追问 Enter 发送，Shift+Enter 与输入法组词 Enter 保留默认行为', () => {
  const event = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }
  assert.equal(submitQuestionOnEnter(event), true)
  for (const patch of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'a' }])
    assert.equal(submitQuestionOnEnter({ ...event, ...patch }), false)
})
test('收起选择跨组件卸载保留，按设备、经理、帖子隔离；摘要只留首个非空行', () => {
  const key = postViewKey('local', 'm1', 'D-1')
  assert.equal(postCollapsed(key, true), true)
  rememberPostCollapsed(key, false)
  assert.equal(postCollapsed(key, true), false)
  assert.equal(postCollapsed(postViewKey('other', 'm1', 'D-1'), true), true)
  assert.equal(postCollapsed(postViewKey('local', 'm2', 'D-1'), true), true)
  assert.equal(postSummary('\n# **第一行** [参考](https://example.com)\n第二行'), '第一行 参考')
})
test('已有临时轮次直接续问；纯经理讨论不触发，手动切回经理优先', () => {
  assert.equal(questionMode(null, []), 'manager')
  assert.equal(questionMode(null, [{ mode: 'manager' }]), 'manager')
  const messages = [{ mode: 'temporary' }, { mode: 'manager' }]
  assert.equal(hasTemporaryQuestions(messages), true)
  assert.equal(questionMode(null, messages), 'temporary')
  assert.equal(questionMode('manager', messages), 'manager')
  assert.equal(questionMode(null, [{}]), 'temporary')
})
test('选项过期删除草稿并提示；空稿静默删除；文字、追问及结束的草稿保持', () => {
  const base = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '' }
  const board = { decisions: [{ id: 'D-1', revision: 2, status: 'open' }], changes: [] }
  assert.deepEqual(refreshAnswerDrafts(board, { 'D-1': base }), { drafts: {}, cleared: ['D-1'] })
  assert.deepEqual(refreshAnswerDrafts(board, { 'D-1': { ...base, optionId: null } }), {
    drafts: {},
    cleared: [],
  })
  for (const patch of [{ text: '补充' }, { question: '依据？' }]) {
    const drafts = { 'D-1': { ...base, ...patch } }
    assert.equal(refreshAnswerDrafts(board, drafts).drafts, drafts)
  }
  const drafts = { 'D-1': base }
  assert.equal(
    refreshAnswerDrafts(
      { ...board, decisions: [{ id: 'D-1', revision: 2, status: 'ignored' }] },
      drafts,
    ).drafts,
    drafts,
  )
})
