// 会话视图 → 对话区的行（src/core/rows.ts）：过程连成一组、展开收起、末尾的状态行、内容没变的行复用同一个对象。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RowBuilder } from '../src/core/rows.ts'
import { experiment } from '../src/experiment.ts'

experiment.seal = 300

const user = (id, text) => ({ id, kind: 'userMessage', text, attachments: [] })
const answer = (id, text, status = 'completed') => ({
  id,
  kind: 'agentMessage',
  text,
  phase: 'final',
  status,
})
const command = (id, status, exitCode = null) => ({
  id,
  kind: 'command',
  command: `run ${id}`,
  cwd: '/w',
  output: `${id} 的输出`,
  elided: null,
  exitCode,
  durationMs: status === 'inProgress' ? null : 12,
  startedAt: null,
  query: '',
})
const notice = (id) => ({ id, kind: 'notice', label: '压缩了上下文', detail: null })

function viewOf(turns, items) {
  return {
    forkedFrom: null,
    turns: turns.map((turn) => ({
      startedAt: null,
      durationMs: null,
      error: null,
      ...turn,
    })),
    items: Object.fromEntries(items.map((item) => [item.id, item])),
  }
}

const types = (rows) => rows.map((row) => row.type)

test('一个回合：用户消息、收起的过程组、回答、状态行', () => {
  const items = [
    user('u', '你好'),
    command('c1', 'completed', 0),
    command('c2', 'completed', 1),
    answer('a', '好的'),
  ]
  const view = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['u', 'c1', 'c2', 'a'], durationMs: 900 }],
    items.map((item) => (item.kind === 'command' ? { ...item, status: 'completed' } : item)),
  )
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'md', 'status'])
  const group = rows[1]
  assert.equal(group.count, 2)
  assert.equal(group.failed, 1, '退出码不是 0 的算没成')
  assert.equal(group.running, false)
  assert.equal(rows[3].durationMs, 900)
})

test('正在跑的一步：摘要上说它在做什么；只有说明的一组不折叠', () => {
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'n', 'c'] }],
    [user('u', '跑'), notice('n'), { ...command('c'), status: 'inProgress' }],
  )
  const rows = new RowBuilder().build(view, 'all')
  // 说明和命令挨着就是同一组；只有说明时单独一行
  assert.deepEqual(types(rows), ['user', 'group', 'status'])
  assert.equal(rows[1].current, 'run c')
  const onlyNotice = viewOf([{ id: 't', status: 'completed', itemIds: ['n'] }], [notice('n')])
  assert.deepEqual(types(new RowBuilder().build(onlyNotice, 'all')), ['notice', 'status'])
})

test('展开一组：每一步各一行排在摘要前面（倒置后摘要在下面）', () => {
  const items = [user('u', '跑'), { ...command('c1'), status: 'completed', exitCode: 0 }]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: ['u', 'c1'] }], items)
  const builder = new RowBuilder()
  const group = builder.build(view, 'all')[1]
  builder.expanded.add(group.key)
  const rows = builder.build(view, new Set(['t']))
  assert.deepEqual(types(rows), ['user', 'step', 'group', 'status'])
  assert.equal(rows[1].output, 'c1 的输出')
  assert.equal(rows[1].state, 'done')
  assert.equal(rows[2].expanded, true)
})

test('没动过的回合原样复用；动过的回合里没变的行还是同一个对象', () => {
  const items = [
    user('u1', '一'),
    answer('a1', '甲'),
    user('u2', '二'),
    answer('a2', '乙', 'inProgress'),
  ]
  const view = viewOf(
    [
      { id: 't1', status: 'completed', itemIds: ['u1', 'a1'] },
      { id: 't2', status: 'running', itemIds: ['u2', 'a2'] },
    ],
    items,
  )
  const builder = new RowBuilder()
  const first = builder.build(view, 'all')
  view.items.a2 = { ...view.items.a2, text: '乙乙乙' }
  const second = builder.build(view, new Set(['t2']))
  assert.equal(second.length, first.length)
  // 第一个回合三行、第二个回合的用户消息：都没变
  for (const index of [0, 1, 2, 3]) assert.equal(second[index], first[index], `第 ${index} 行复用`)
  assert.notEqual(second[4], first[4], '在长的回答换了一行')
  assert.equal(second[4].text, '乙乙乙')
  assert.equal(second[4].live, true)
  assert.equal(second[5], first[5], '状态行没变')
  // 回合结束：状态行的键不变、内容换了
  view.turns[1].status = 'completed'
  view.items.a2 = { ...view.items.a2, status: 'completed' }
  const third = builder.build(view, new Set(['t2']))
  assert.equal(third[5].key, first[5].key)
  assert.equal(third[5].status, 'completed')
  assert.equal(third[4].live, false)
})

test('失败的回合在状态行上面带一行原因；被删掉的回合不再出行', () => {
  const view = viewOf(
    [
      { id: 't1', status: 'failed', itemIds: ['u1'], error: '模型报错了' },
      { id: 't2', status: 'interrupted', itemIds: ['u2'], error: '不画' },
    ],
    [user('u1', '一'), user('u2', '二')],
  )
  const builder = new RowBuilder()
  assert.deepEqual(types(builder.build(view, 'all')), ['user', 'error', 'status', 'user', 'status'])
  view.turns.shift()
  assert.deepEqual(types(builder.build(view, 'all')), ['user', 'status'])
})

test('分叉来的会话最上面一行说从哪来', () => {
  const view = { ...viewOf([], []), forkedFrom: '原来的会话' }
  assert.deepEqual(new RowBuilder().build(view, 'all'), [
    { type: 'forked', key: 'forked', from: '原来的会话' },
  ])
})
