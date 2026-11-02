import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decisionAnswerParts,
  managerBoardPages,
  managerReopen,
  parseManagerIssueOrder,
  reopenedClosure,
  sortManagerIssues,
} from '../src/index.mjs'

const rows = [
  { id: 'a', at: 10, pending: false },
  { id: 'b', at: 30, pending: true },
  { id: 'c', at: 20, pending: false },
  { id: 'd', at: 5, pending: true },
  { id: 'e', at: 20, pending: true },
]
const ids = (list: { id: string }[]) => list.map((row) => row.id).join('')

test('控制台排序：默认最新优先、最早优先、待处理优先组内按最新，同时间按输入次序', () => {
  assert.equal(ids(sortManagerIssues(rows, 'newest', (r) => r)), 'becad')
  assert.equal(ids(sortManagerIssues(rows, 'oldest', (r) => r)), 'daceb')
  assert.equal(ids(sortManagerIssues(rows, 'pending', (r) => r)), 'bedca')
  assert.equal(ids(rows), 'abcde', '不改输入')
})

test('排序设置认不出就回默认', () => {
  assert.equal(parseManagerIssueOrder('oldest'), 'oldest')
  assert.equal(parseManagerIssueOrder('pending'), 'pending')
  assert.equal(parseManagerIssueOrder('updated'), 'newest')
  assert.equal(parseManagerIssueOrder(null), 'newest')
})

const options = [
  { id: 'a', label: 'A', description: '' },
  { id: 'b', label: 'B', description: '说明' },
  { id: 'c', label: 'C', description: '' },
]
const answer = { optionId: 'b', text: '理由', by: 'user' as const, at: 1 }
const closed = { reason: '不用定了', by: 'manager' as const, at: 2 }

test('已答决策：答复、选中项与其他选项分开', () => {
  const parts = decisionAnswerParts({ status: 'answered', options, answer, closed: null })
  assert.equal(parts.answerKind, 'current')
  assert.equal(parts.chosen?.id, 'b')
  assert.deepEqual(
    parts.others.map((o) => o.id),
    ['a', 'c'],
  )
  assert.equal(parts.closed, null)
})

test('只有文字的答复：选项全部算其他选项；关闭前的答复保留', () => {
  const parts = decisionAnswerParts({
    status: 'withdrawn',
    options,
    answer: { ...answer, optionId: null },
    closed,
  })
  assert.equal(parts.answerKind, 'current')
  assert.equal(parts.chosen, null)
  assert.equal(parts.others.length, 3)
  assert.equal(parts.closed?.reason, '不用定了')
})

test('重新打开：旧答复记为上次的答复，不显示关闭记录', () => {
  const parts = decisionAnswerParts({ status: 'open', options, answer, closed })
  assert.equal(parts.answerKind, 'previous')
  assert.equal(parts.closed, null)
  const fresh = decisionAnswerParts({ status: 'open', options, answer: null, closed: null })
  assert.equal(fresh.answerKind, null)
  assert.equal(fresh.others.length, 3)
})

test('答复指向已删掉的选项：不当作选中', () => {
  const parts = decisionAnswerParts({
    status: 'answered',
    options,
    answer: { ...answer, optionId: 'z' },
    closed: null,
  })
  assert.equal(parts.chosen, null)
  assert.equal(parts.others.length, 3)
})

test('重新打开：重开前的关闭记录只在待定时给出', () => {
  const open = decisionAnswerParts({
    status: 'open',
    options,
    answer,
    closed: null,
    previousClosed: closed,
  })
  assert.equal(open.previousClosed?.reason, '不用定了')
  const answered = decisionAnswerParts({
    status: 'answered',
    options,
    answer,
    closed: null,
    previousClosed: closed,
  })
  assert.equal(answered.previousClosed, null)
})

test('从变更记录找回重开前的关闭：只看最近一次状态变化', () => {
  const change = (
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) => ({
    id: `c-${id}`,
    objectId: 'D-1' as const,
    by: 'user' as const,
    at: 3,
    fields: [],
    before,
    after,
    why: '',
  })
  const reopen = change('reopen', { status: 'withdrawn', closed }, { status: 'open', closed: null })
  const close = change('close', { status: 'open', closed: null }, { status: 'withdrawn', closed })
  const edit = change('edit', { status: 'open', title: 'a' }, { status: 'open', title: 'b' })
  const decision = { id: 'D-1' as const, status: 'open' as const }
  assert.deepEqual(reopenedClosure(decision, [edit, reopen, close]), closed, '重开后又改过标题')
  assert.equal(reopenedClosure(decision, [close]), null, '最近一次状态变化不是重开')
  assert.equal(reopenedClosure({ ...decision, status: 'answered' }, [reopen]), null, '已答不给')
  assert.equal(reopenedClosure({ ...decision, id: 'D-2' }, [reopen]), null, '别的决策')
  assert.equal(reopenedClosure(decision, []), null, '从没关过')
})

test('经理重开用户忽略的决策：给出经理写的理由；用户自己撤销忽略不给，也不算上次关闭', () => {
  const ignoredBy = { reason: '先不管', by: 'user' as const, at: 2 }
  const change = (
    by: 'user' | 'manager',
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    why: string,
  ) => ({
    id: `c-${by}-${why}`,
    objectId: 'D-1' as const,
    by,
    at: 5,
    fields: [],
    before,
    after,
    why,
  })
  const ignore = change(
    'user',
    { status: 'open', closed: null },
    { status: 'ignored', closed: ignoredBy },
    'Decision ignored',
  )
  const managerReopened = change(
    'manager',
    { status: 'ignored', closed: ignoredBy },
    { status: 'open', closed: null },
    '情况变了',
  )
  const userReopened = change(
    'user',
    { status: 'ignored', closed: ignoredBy },
    { status: 'open', closed: null },
    'Decision reopened',
  )
  const decision = { id: 'D-1' as const, status: 'open' as const }
  assert.deepEqual(managerReopen(decision, [managerReopened, ignore]), {
    reason: '情况变了',
    by: 'manager',
    at: 5,
  })
  assert.equal(managerReopen(decision, [userReopened, ignore]), null, '用户撤销忽略')
  assert.equal(reopenedClosure(decision, [managerReopened, ignore]), null, '不算上次关闭')
  assert.equal(managerReopen({ ...decision, status: 'ignored' }, [ignore]), null, '还在忽略')
  const parts = decisionAnswerParts({
    status: 'open',
    options,
    answer: null,
    closed: null,
    reopened: { reason: '情况变了', by: 'manager', at: 5 },
  })
  assert.equal(parts.reopened?.reason, '情况变了')
  assert.equal(
    decisionAnswerParts({
      status: 'ignored',
      options,
      answer: null,
      closed: ignoredBy,
      reopened: { reason: '情况变了', by: 'manager', at: 5 },
    }).reopened,
    null,
  )
})

test('忽略的决策单独成组，不计待定', () => {
  const base = { options: [], answer: null, closed: null, revision: 1 }
  const pages = managerBoardPages({
    decisions: [
      { ...base, id: 'D-1', status: 'open' },
      { ...base, id: 'D-2', status: 'ignored', closed: { reason: '', by: 'user', at: 1 } },
      { ...base, id: 'D-3', status: 'withdrawn' },
    ],
    items: [],
    lines: [],
    activities: [],
    situation: null,
  } as never)
  assert.deepEqual(
    pages.decisions.ignored.map((d) => d.id),
    ['D-2'],
  )
  assert.deepEqual(
    pages.decisions.closed.map((d) => d.id),
    ['D-3'],
  )
  assert.equal(pages.overview.stats.pendingDecisions, 1)
})
