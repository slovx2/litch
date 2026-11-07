import assert from 'node:assert/strict'
import test from 'node:test'
import {
  liveManagerDrafts,
  resetDecisionSelection,
} from '../../../packages/core/src/projection/manager-drafts.mts'
import {
  postCollapsed,
  postViewKey,
  questionMode,
  rememberPostCollapsed,
} from '../../../packages/ui/src/manager/post-presentation.ts'
import { canAnimateToggle, issueMarkdownStyle } from '../src/screens/managers/presentation.ts'
import { PALETTES } from '../src/ui/palettes.ts'

test('手机讨论与桌面共用默认目标和会话内收起状态', () => {
  assert.equal(questionMode(null, [{ mode: 'temporary' }]), 'temporary')
  assert.equal(questionMode('manager', [{ mode: 'temporary' }]), 'manager')
  const key = postViewKey('phone', 'manager', 'D-1')
  rememberPostCollapsed(key, true)
  assert.equal(postCollapsed(key, false), true)
})
test('手机新版本保留选项、文字和追问，仅空稿跟随新版', () => {
  const board = { decisions: [{ id: 'D-1', revision: 2, status: 'open' }], changes: [] }
  const draft = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '' }
  assert.equal(resetDecisionSelection(board, draft), false)
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

test('分页卡开合：上方另有展开的卡时不做布局动画，免得和瞬时滚动补偿叠成先跳再滑', () => {
  const positions = new Map([
    ['D-1', 0],
    ['D-2', 120],
  ])
  assert.equal(canAnimateToggle(null, 'D-2', positions), true)
  assert.equal(canAnimateToggle('D-2', 'D-2', positions), true)
  assert.equal(canAnimateToggle('D-2', 'D-1', positions), true)
  assert.equal(canAnimateToggle('D-1', 'D-2', positions), false)
  assert.equal(canAnimateToggle('D-9', 'D-2', positions), false)
})

test('手机草稿文件的答复、关闭、删除与版本变化采用同一计数规则', async () => {
  const { baseFile, choiceFile, editFile, clearDrafts } = await import(
    '../src/screens/managers/draft-files.ts'
  )
  const { draftMarks } = await import('../src/screens/managers/draft-marks.ts')
  const key = JSON.stringify(['test', 'm-drafts', 'D-1'])
  baseFile.write({ [key]: 1 })
  choiceFile.write({ [key]: 'a' })
  const head = { id: 'D-1', kind: 'decision', revision: 1 }
  const draft = { decisionId: 'D-1', revision: 1, optionId: 'a', text: '' }
  for (const status of ['answered', 'expired', 'withdrawn']) {
    const board = { decisions: [{ id: 'D-1', status, revision: 1 }], changes: [] }
    assert.equal(
      draftMarks(board, { deviceId: 'test', managerId: 'm-drafts' }, [head]).get('D-1').state,
      'ended',
    )
    assert.equal(liveManagerDrafts(board, { decisions: [draft], requests: [], posts: [] }).count, 0)
  }
  assert.equal(
    liveManagerDrafts(
      { decisions: [], changes: [] },
      { decisions: [draft], requests: [], posts: [] },
    ).count,
    0,
  )
  const changed = { decisions: [{ id: 'D-1', status: 'open', revision: 2 }], changes: [] }
  assert.equal(
    draftMarks(changed, { deviceId: 'test', managerId: 'm-drafts' }, [head]).get('D-1').state,
    'conflict',
  )
  assert.equal(choiceFile.read()[key], 'a', '选项留在文件中')
  editFile.write({ [key]: 1 })
  const answered = { decisions: [{ id: 'D-1', status: 'answered', revision: 1 }], changes: [] }
  assert.equal(
    draftMarks(answered, { deviceId: 'test', managerId: 'm-drafts' }, [head]).get('D-1').state,
    'live',
  )
  clearDrafts([key], { choice: true, reply: true, question: true })
  assert.equal(editFile.read()[key], undefined)
})
