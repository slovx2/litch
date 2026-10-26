// 待办（src/detail/todo/logic.ts、会话存储里最近那份、对话里那一行）：取哪一份、输入框上方的小按钮出不出、
// 对话里平时一行、点了在原处展开。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { RowBuilder } from '../src/core/rows.ts'
import { SessionStore } from '../src/core/session-store.ts'
import { currentStep, latestTodo, stepStatus, todoChipShown } from '../src/detail/todo/logic.ts'
import { mockChannel, until } from './helpers.mjs'

const steps = (...statuses) =>
  statuses.map((status, index) => ({ text: `第${index + 1}步`, status }))
const todo = (turnId, list) => ({ id: `${turnId}:#todo`, kind: 'todo', note: null, steps: list })
const turn = (id, status, itemIds) => ({
  id,
  status,
  itemIds,
  startedAt: null,
  durationMs: null,
  error: null,
})

test('最近那份：从最后一个回合往前找第一份有步骤的；没有是 null', () => {
  const old = todo('t1', steps('completed', 'pending'))
  const items = { [old.id]: old }
  const view = { turns: [turn('t1', 'completed', [old.id]), turn('t2', 'running', [])], items }
  assert.deepEqual(latestTodo(view), { turnId: 't1', item: old, running: false })
  const fresh = todo('t2', steps('inProgress'))
  const next = {
    turns: [turn('t1', 'completed', [old.id]), turn('t2', 'running', [fresh.id])],
    items: { ...items, [fresh.id]: fresh },
  }
  assert.deepEqual(latestTodo(next), { turnId: 't2', item: fresh, running: true })
  // 空的一份不算
  const empty = todo('t2', [])
  assert.equal(
    latestTodo({ ...next, items: { ...items, [empty.id]: empty } }).turnId,
    't1',
    '空的跳过，往前找',
  )
  assert.equal(latestTodo({ turns: [turn('t1', 'running', [])], items: {} }), null)
})

test('小按钮：有没做完的就出（回合结束了也出）；全做完了只在它的回合还在跑时出', () => {
  const item = todo('t', steps('completed', 'pending'))
  assert.equal(todoChipShown(null), false)
  assert.equal(todoChipShown({ turnId: 't', item, running: false }), true)
  const all = todo('t', steps('completed', 'completed'))
  assert.equal(todoChipShown({ turnId: 't', item: all, running: true }), true)
  assert.equal(todoChipShown({ turnId: 't', item: all, running: false }), false)
})

test('对话里那一行写哪一步：正在做的，没有就是第一个没做的；回合结束了“正在做”算没做', () => {
  const list = steps('completed', 'pending', 'inProgress')
  assert.equal(currentStep(list, true).text, '第3步')
  assert.equal(currentStep(list, false).text, '第2步')
  assert.equal(currentStep(steps('completed'), true), null)
  assert.equal(stepStatus(list[2], false), 'pending')
  assert.equal(stepStatus(list[2], true), 'inProgress')
})

test('对话里的待办：平时一行，展开了带上 expanded，回合号跟着行走', () => {
  const user = { id: 'u', kind: 'userMessage', text: '做吧', attachments: [] }
  const item = todo('t', steps('completed', 'inProgress'))
  const view = {
    turns: [turn('t', 'running', ['u', item.id])],
    items: { u: user, [item.id]: item },
    forkedFrom: null,
    can: { finalOnStart: false },
    agents: [],
    proposals: [],
    requests: [],
  }
  const builder = new RowBuilder()
  const row = builder.build(view, 'all').find((each) => each.type === 'todo')
  assert.equal(row.expanded, false)
  assert.equal(row.turnId, 't')
  assert.equal(row.running, true)
  builder.expanded.add(item.id)
  assert.equal(builder.build(view, 'all').find((each) => each.type === 'todo').expanded, true)
})

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

test('会话存储：待办一步步做完时最近那份跟着换；回合结束后全做完了小按钮收掉', async () => {
  const mock = mockChannel()
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '待办',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  const seen = []
  store.subscribeTodo(() => seen.push(store.getTodo()))
  store.start()
  await until(() => store.getTodo()?.running === true, { what: '待办出来' })
  assert.equal(todoChipShown(store.getTodo()), true)
  await until(() => store.getSnapshot().rows[0]?.status === 'completed', { what: '回合结束' })
  await until(() => store.getTodo()?.running === false, { what: '回合结束后再换一份' })
  const last = store.getTodo()
  assert.ok(last.item.steps.every((step) => step.status === 'completed'))
  assert.equal(todoChipShown(last), false)
  assert.ok(seen.length >= 3, `待办换了几次：${seen.length}`)
  // 同一份没变时不重复通知
  assert.ok(seen.every((value, index) => index === 0 || value !== seen[index - 1]))
})
