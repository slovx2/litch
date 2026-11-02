import assert from 'node:assert/strict'
import test from 'node:test'
import { managerAttentionCount } from '../../../packages/core/src/projection/manager.mts'
import { relationGroups } from '../../../packages/protocol/src/manager-relations.mts'
import {
  collapsedMarkdown,
  decisionActions,
  issueCounts,
  issueMarkdownStyle,
  managerRowState,
  orderedIssues,
  plainLine,
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

test('手机议题默认最新优先，可切最早、待处理优先；类别数只计待处理，报告仅显示未读', () => {
  const posts = [
    { id: 'D-closed', kind: 'decision', createdAt: 3 },
    { id: 'D-done', kind: 'decision', createdAt: 2 },
    { id: 'D-open', kind: 'decision', createdAt: 1 },
    { id: 'R-1', kind: 'request', createdAt: 4 },
    { id: 'P-1', kind: 'report', createdAt: 0, unread: true },
    { id: 'S-x', kind: 'suggestion', createdAt: 5, proposalId: 'x' },
  ]
  const board = {
    decisions: [
      { id: 'D-closed', status: 'withdrawn' },
      { id: 'D-done', status: 'answered' },
      { id: 'D-open', status: 'open' },
    ],
    requests: [{ id: 'R-1', status: 'replied' }],
  }
  const suggestions = [
    { proposal: { id: 'x' }, managerId: 'm1', managerReview: { state: 'endorsed' } },
  ]
  const ids = (order) => orderedIssues(posts, board, order, suggestions).map((p) => p.id)
  assert.deepEqual(ids('newest'), ['S-x', 'R-1', 'D-closed', 'D-done', 'D-open', 'P-1'])
  assert.deepEqual(ids('oldest'), ['P-1', 'D-open', 'D-done', 'D-closed', 'R-1', 'S-x'])
  assert.deepEqual(ids('pending'), ['S-x', 'D-open', 'P-1', 'R-1', 'D-closed', 'D-done'])
  assert.deepEqual(
    posts.map((p) => p.id),
    ['D-closed', 'D-done', 'D-open', 'R-1', 'P-1', 'S-x'],
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

test('关闭决策无答案时仅可重开，有答案时保留修改与重开，已答复不能重开；待定可忽略，忽略的可撤销', () => {
  const none = { ignore: false, unignore: false }
  for (const status of ['expired', 'withdrawn']) {
    assert.deepEqual(decisionActions({ status, answer: null }), {
      edit: false,
      reopen: true,
      ...none,
    })
    assert.deepEqual(decisionActions({ status, answer: { text: '旧答案' } }), {
      edit: true,
      reopen: true,
      ...none,
    })
  }
  assert.deepEqual(decisionActions({ status: 'answered', answer: { text: '答案' } }), {
    edit: true,
    reopen: false,
    ...none,
  })
  assert.deepEqual(decisionActions({ status: 'open', answer: null }), {
    edit: false,
    reopen: false,
    ignore: true,
    unignore: false,
  })
  assert.deepEqual(decisionActions({ status: 'ignored', answer: null }), {
    edit: false,
    reopen: false,
    ignore: false,
    unignore: true,
  })
})

test('经理目录行只显示一行纯文字；收起的长动态只取前几行并补齐代码块', () => {
  assert.equal(plainLine('\n**工作线回报**\n\n- 完成'), '工作线回报')
  assert.equal(plainLine('- 见 [核对记录](https://x) 与 `revision`'), '见 核对记录 与 revision')
  assert.equal(collapsedMarkdown('a\nb', 5), null)
  assert.equal(collapsedMarkdown('1\n2\n3\n4\n5\n6', 5), '1\n2\n3\n4\n5')
  assert.equal(collapsedMarkdown('x\n```\ncode\nmore\nend\n```', 4), 'x\n```\ncode\nmore\n```')
})

test('经理目录行：记号只看经理会话自己，工作线在跑另写文字', () => {
  const manager = {
    status: 'active',
    runningLines: 2,
    pendingDecisions: 0,
    pendingRequests: 0,
    pendingSuggestions: 0,
  }
  const idle = { status: 'idle', background: null }
  assert.deepEqual(managerRowState(manager, idle), {
    mark: 'idle',
    pending: 0,
    text: { key: 'manager.linesCount', n: 2 },
  })
  assert.deepEqual(managerRowState(manager, { status: 'running', background: null }), {
    mark: 'running',
    pending: 0,
    text: { key: 'manager.running' },
  })
  assert.deepEqual(
    managerRowState(manager, { status: 'waiting', background: null }).mark,
    'waiting',
  )
  assert.deepEqual(managerRowState(manager, { status: 'error', background: null }).mark, 'error')
  const own = { status: 'idle', background: { running: 3 } }
  assert.deepEqual(managerRowState({ ...manager, runningLines: 0 }, own), {
    mark: 'background',
    pending: 0,
    text: { key: 'background.sidebar', count: 3 },
  })
  assert.deepEqual(managerRowState(manager, own).text, { key: 'manager.linesCount', n: 2 })
  assert.deepEqual(managerRowState({ ...manager, runningLines: 0 }, idle).text, {
    key: 'manager.idle',
  })
  // 待处理数画成行尾胶囊，记号与文字照旧只看经理自己和工作线
  assert.deepEqual(managerRowState({ ...manager, pendingDecisions: 4, pendingRequests: 1 }, idle), {
    mark: 'idle',
    pending: 5,
    text: { key: 'manager.linesCount', n: 2 },
  })
  assert.deepEqual(managerRowState({ ...manager, status: 'ended', pendingDecisions: 4 }, idle), {
    mark: 'offline',
    pending: 0,
    text: { key: 'manager.ended' },
  })
})
