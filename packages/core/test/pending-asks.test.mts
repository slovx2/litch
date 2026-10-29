import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ItemView, QueuedMessage, TurnView, UserMessageItem } from '../src/model.mjs'
import { askQuestionId, gatherAnswers } from '../src/projection/asks.mjs'
import { pendingQuestions, pendingReplyText } from '../src/projection/pending-asks.mjs'

const wrap = (id: string, ask = '继续修复吗？', withdrawQuestions?: string[]): ItemView => ({
  id,
  kind: 'toolCall',
  source: 'litch_sessions',
  tool: 'wrap_up',
  status: 'completed',
  input: [],
  output: [],
  error: null,
  durationMs: null,
  wrapUp: {
    suggestions: [],
    ask,
    actions: [{ label: '继续', message: '请继续修复' }],
    ...(withdrawQuestions ? { withdrawQuestions } : {}),
  },
})
const user = (id: string, text: string): UserMessageItem => ({
  id,
  kind: 'userMessage',
  text,
  attachments: [],
})
const turn = (
  id: string,
  itemIds: string[],
  status: TurnView['status'] = 'completed',
): TurnView => ({
  id,
  itemIds,
  status,
  startedAt: null,
  durationMs: null,
  error: null,
})

test('未答收尾跨子会话回报、定时任务、后台唤醒保留；新旧问题共存、同题合并', () => {
  const items = [
    wrap('w1'),
    { ...user('wake', ''), event: { kind: 'wake', notes: [] } } as ItemView,
    wrap('w2', '另一个问题？'),
    wrap('w3'),
  ]
  const byId = Object.fromEntries(items.map((item) => [item.id, item]))
  const turns = [turn('t1', ['w1']), turn('t2', ['wake', 'w2', 'w3'])]
  const questions = pendingQuestions(turns, (id) => byId[id], {})
  assert.equal(questions.length, 2)
  assert.equal(questions[0]?.replyIds.length, 2)
  assert.ok(questions[0])
  const reply = user('reply', pendingReplyText(questions[0], '请继续修复'))
  const answers = gatherAnswers({}, [reply])
  assert.deepEqual(
    pendingQuestions(turns, (id) => byId[id], answers).map((q) => q.title),
    ['另一个问题？'],
  )
  for (const origin of ['schedule', 'backgroundTask', 'peer'] as const) {
    const automated = [...turns, { ...turn('auto', []), origin }]
    assert.deepEqual(
      pendingQuestions(automated, (id) => byId[id], {}),
      questions,
    )
  }
})

test('异步问题逐题回答；排队答复不重复提交，撤销排队后恢复；快照重建得到同一集合', () => {
  const q: ItemView = {
    id: 'a',
    kind: 'agentMessage',
    text: '',
    status: 'completed',
    phase: 'commentary',
    questions: [
      { id: askQuestionId('a', 0), title: 'A?', options: ['A'] },
      { id: askQuestionId('a', 1), title: 'B?', options: [] },
    ],
  }
  const turns = [turn('t1', ['a']), turn('t2', [])]
  const itemOf = (id: string) => (id === 'a' ? q : undefined)
  const questions = pendingQuestions(turns, itemOf, {})
  assert.ok(questions[0])
  const text = pendingReplyText(questions[0], 'A')
  const queued: QueuedMessage[] = [{ id: 'queued', text, images: [], extras: [] }]
  assert.deepEqual(
    pendingQuestions(turns, itemOf, {}, queued).map((q) => q.title),
    ['B?'],
  )
  assert.equal(pendingQuestions(turns, itemOf, {}).length, 2)
  const answers = gatherAnswers({}, [user('reply', text)])
  assert.deepEqual(
    pendingQuestions(turns, itemOf, answers).map((q) => q.title),
    ['B?'],
  )
  assert.deepEqual(
    pendingQuestions(structuredClone(turns), itemOf, structuredClone(answers)),
    pendingQuestions(turns, itemOf, answers),
  )
})

test('只有明确撤回才移除：空收尾不撤回；新问题不覆盖旧题；同回合的多个问题都保留', () => {
  const items = [
    wrap('a'),
    wrap('b', 'B?'),
    wrap('empty', ''),
    wrap('withdraw', '', ['继续修复吗？']),
    wrap('new', '继续修复吗？'),
  ]
  const byId = Object.fromEntries(items.map((item) => [item.id, item]))
  assert.equal(pendingQuestions([turn('t', ['a', 'b', 'empty'])], (id) => byId[id], {}).length, 2)
  assert.deepEqual(
    pendingQuestions([turn('t', ['a', 'b', 'withdraw'])], (id) => byId[id], {}).map((q) => q.title),
    ['B?'],
  )
  assert.deepEqual(
    pendingQuestions(
      [
        turn(
          't',
          items.map((i) => i.id),
        ),
      ],
      (id) => byId[id],
      {},
    ).map((q) => q.itemId),
    ['b', 'new'],
  )
  assert.equal(pendingQuestions([turn('t', ['a'], 'running')], (id) => byId[id], {}).length, 0)
})

test('用户直接发话收起此前的收尾和异步题；自发消息不算，带题目标识的回复只收对应题', () => {
  const async: ItemView = {
    id: 'async',
    kind: 'agentMessage',
    text: '',
    status: 'completed',
    phase: 'commentary',
    questions: [{ id: 'q', title: '第二题？', options: [] }],
  }
  const items: Record<string, ItemView> = { w: wrap('w'), async, u: user('u', '用户的回答') }
  const old = turn('old', ['w', 'async'])
  const after = turn('new', ['u'])
  const get = (id: string) => items[id]
  assert.equal(pendingQuestions([old, after], get, {}).length, 0)
  for (const origin of ['schedule', 'backgroundTask', 'peer', 'goal'] as const)
    assert.equal(pendingQuestions([old, { ...after, origin }], get, {}).length, 2)
  items.u = { ...user('u', ''), event: { kind: 'wake', notes: [] } }
  assert.equal(pendingQuestions([old, after], get, {}).length, 2)
  items.u = { ...user('u', '真实用户正文'), event: { kind: 'notes', notes: [] } }
  assert.equal(pendingQuestions([old, after], get, {}).length, 0)
  const questions = pendingQuestions([old], get, {})
  assert.ok(questions[0])
  items.u = user('u', pendingReplyText(questions[0], '明确回答第一题'))
  assert.deepEqual(
    pendingQuestions([old, after], get, gatherAnswers({}, [items.u])).map((q) => q.id),
    ['q'],
  )
})
