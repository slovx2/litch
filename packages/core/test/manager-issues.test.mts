import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionAnswerParts, parseManagerIssueOrder, sortManagerIssues } from '../src/index.mjs'

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
