import assert from 'node:assert/strict'
import test from 'node:test'
import { resetDecisionSelection } from '../../../packages/core/src/projection/manager-drafts.mts'
import {
  postCollapsed,
  postViewKey,
  questionMode,
  rememberPostCollapsed,
} from '../../../packages/ui/src/manager/post-presentation.ts'
import { issueMarkdownStyle } from '../src/screens/managers/presentation.ts'
import { PALETTES } from '../src/ui/palettes.ts'

test('手机讨论与桌面共用默认目标和会话内收起状态', () => {
  assert.equal(questionMode(null, [{ mode: 'temporary' }]), 'temporary')
  assert.equal(questionMode('manager', [{ mode: 'temporary' }]), 'manager')
  const key = postViewKey('phone', 'manager', 'D-1')
  rememberPostCollapsed(key, true)
  assert.equal(postCollapsed(key, false), true)
})
test('手机新版本仅选项清空，有文字或追问保持旧版本待核对', () => {
  const board = { decisions: [{ id: 'D-1', revision: 2, status: 'open' }], changes: [] }
  const draft = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '' }
  assert.equal(resetDecisionSelection(board, draft), true)
  assert.equal(resetDecisionSelection(board, { ...draft, optionId: null }), true)
  assert.equal(resetDecisionSelection(board, { ...draft, text: '其他建议' }), false)
  assert.equal(resetDecisionSelection(board, { ...draft, question: '补充依据' }), false)
})
test('手机议题正文沿用对话的主题字号', () => {
  for (const skin of ['retro', 'human', 'standard']) {
    const theme = {
      skin,
      dark: false,
      c: PALETTES[skin].light,
      font: { mono: 'monospace', size: { body: 15, title: 17, meta: 13, small: 11 } },
      radius: { s: 0, m: 0, l: 0 },
    }
    assert.equal(issueMarkdownStyle(theme).paragraph.fontSize, theme.font.size.body)
  }
})
