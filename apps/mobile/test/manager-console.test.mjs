import assert from 'node:assert/strict'
import test from 'node:test'
import { managerAttentionCount } from '../../../packages/core/src/projection/manager.mts'
import { relationGroups } from '../../../packages/protocol/src/manager-relations.mts'
import {
  decisionActions,
  issueCounts,
  issueMarkdownStyle,
  orderedIssues,
} from '../src/screens/managers/presentation.ts'
import { issueLinks } from '../src/screens/managers/relations.ts'
import { PALETTES } from '../src/ui/palettes.ts'

test('手机议题编号只链接存在对象，保留代码与明确链接', () => {
  const ids = new Set(['D-1', 'I-2', 'P-3'])
  assert.equal(
    issueLinks('#D-1、I-2 与 #P-3；#D-999 `#D-1` [原链接](https://x/#D-1)', ids),
    '[#D-1](litch-issue:D-1)、[#I-2](litch-issue:I-2) 与 [#P-3](litch-issue:P-3)；#D-999 `#D-1` [原链接](https://x/#D-1)',
  )
})
test('同一关系正向是来源，反向是派生；相关关系双向对称', () => {
  const a = { kind: 'issue', target: 'P-1' },
    b = { kind: 'item', target: 'I-1' }
  const edge = { id: 'one', from: a, to: b, kind: 'derived', at: 1, by: 'manager' }
  assert.deepEqual(relationGroups([edge], a).source, [b])
  assert.deepEqual(relationGroups([edge], b).derived, [a])
  assert.deepEqual(relationGroups([{ ...edge, kind: 'related' }], b).related, [a])
})

test('D-29：手机使用核心统一口径，报告未读不占待处理', () => {
  const manager = {
    pendingDecisions: 3,
    pendingRequests: 1,
    pendingSuggestions: 2,
    pendingReports: 9,
  }
  assert.equal(managerAttentionCount(manager), 6)
  assert.equal(managerAttentionCount({ ...manager, pendingReports: 0 }), 6)
  assert.equal(
    managerAttentionCount({
      ...manager,
      pendingDecisions: 0,
      pendingRequests: 0,
      pendingSuggestions: 0,
    }),
    0,
  )
})

test('手机决策优先未答；类别数只计待处理，报告仅显示未读', () => {
  const posts = ['D-closed', 'D-done', 'D-open'].map((id) => ({ id, kind: 'decision' }))
  const decisions = [
    { id: 'D-closed', status: 'withdrawn' },
    { id: 'D-done', status: 'answered' },
    { id: 'D-open', status: 'open' },
  ]
  assert.deepEqual(
    orderedIssues(posts, decisions).map((p) => p.id),
    ['D-open', 'D-done', 'D-closed'],
  )
  assert.deepEqual(
    posts.map((p) => p.id),
    ['D-closed', 'D-done', 'D-open'],
  )
  assert.deepEqual(
    issueCounts({
      pendingDecisions: 3,
      pendingRequests: 1,
      pendingSuggestions: 2,
      pendingReports: 7,
    }),
    { decision: 3, request: 1, suggestion: 2, report: 7 },
  )
})
test('手机三皮肤报告正文标题不大于卡片标题', () => {
  for (const skin of ['standard', 'human', 'retro'])
    for (const dark of [false, true]) {
      const theme = {
          skin,
          dark,
          c: PALETTES[skin][dark ? 'dark' : 'light'],
          font: { mono: 'monospace', size: { body: 15, title: 17, meta: 13, small: 11 } },
          radius: { s: 0, m: 0, l: 0 },
        },
        style = issueMarkdownStyle(theme)
      for (const key of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
        assert.ok(style[key].fontSize < theme.font.size.title)
    }
})

test('关闭决策无答案时仅可重开，有答案时保留修改与重开，已答复不能重开', () => {
  for (const status of ['expired', 'withdrawn']) {
    assert.deepEqual(decisionActions({ status, answer: null }), { edit: false, reopen: true })
    assert.deepEqual(decisionActions({ status, answer: { text: '旧答案' } }), {
      edit: true,
      reopen: true,
    })
  }
  assert.deepEqual(decisionActions({ status: 'answered', answer: { text: '答案' } }), {
    edit: true,
    reopen: false,
  })
  assert.deepEqual(decisionActions({ status: 'open', answer: null }), {
    edit: false,
    reopen: false,
  })
})
