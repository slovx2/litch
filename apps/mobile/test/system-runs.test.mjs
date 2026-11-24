// 跨回合收起块在手机上的行（src/core/rows.ts，规矩在核心的 systemRuns）：连续的系统回合并成一行标题，
// 用户的话、正文把块切开，正在跑的回合照常画，点标题行整块开合。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RowBuilder } from '../src/core/rows.ts'
import { experiment } from '../src/experiment.ts'

experiment.seal = 300

const user = (id, text = '用户的话') => ({ id, kind: 'userMessage', text, attachments: [] })
const report = (id) => ({
  id,
  kind: 'userMessage',
  text: '',
  attachments: [],
  event: {
    kind: 'notes',
    notes: [{ threadId: 'child', title: '子会话', status: 'completed', excerpt: '做完了' }],
  },
})
const read = (id) => ({
  id,
  kind: 'toolCall',
  source: 'litch_sessions',
  tool: 'read',
  input: [],
  output: [],
  error: null,
  durationMs: 10,
  status: 'completed',
})
const answer = (id) => ({
  id,
  kind: 'agentMessage',
  text: '写给用户的话',
  phase: 'unknown',
  status: 'completed',
})

function viewOf(turns) {
  const items = {}
  return {
    forkedFrom: null,
    can: { finalOnStart: false },
    agents: [],
    proposals: [],
    requests: [],
    turns: turns.map(([id, list, status = 'completed']) => {
      for (const item of list) items[item.id] = item
      return {
        id,
        status,
        itemIds: list.map((item) => item.id),
        startedAt: null,
        durationMs: 1000,
        error: null,
      }
    }),
    items,
  }
}

/** 行的种类和所属回合，标题行写成 run */
const shape = (rows) =>
  rows.map((row) => (row.key.endsWith(':run') ? `run:${row.turnId}` : `${row.type}:${row.turnId}`))

test('连续几条回报：一行标题汇总用时、步数和回报条数，收着时不画系统消息、过程和回合尾', () => {
  const view = viewOf([
    ['r1', [report('r1-u'), read('r1-c')]],
    ['r2', [report('r2-u'), read('r2-c1'), read('r2-c2')]],
    ['r3', [report('r3-u'), read('r3-c')]],
  ])
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.deepEqual(shape(rows), ['run:r1'])
  const head = rows[0]
  assert.equal(head.type, 'process')
  assert.equal(head.steps, 4)
  assert.equal(head.durationMs, 3000)
  assert.deepEqual(head.messages, [{ kind: 'report', n: 3 }])
  assert.equal(head.expanded, false)
  // 点开：按时间排每条回报、它的过程和回合尾
  builder.toggle('r1:run', 'r1')
  const open = builder.build(view, new Set(['r1']))
  assert.equal(open[0].expanded, true)
  assert.deepEqual(
    shape(open).filter((entry) => !entry.startsWith('run')),
    [
      'event:r1',
      'group:r1',
      'status:r1',
      'event:r2',
      'group:r2',
      'status:r2',
      'event:r3',
      'group:r3',
      'status:r3',
    ],
  )
  builder.toggle('r1:run', 'r1')
  assert.deepEqual(shape(builder.build(view, new Set(['r1']))), ['run:r1'])
})

const peer = (id) => ({
  id,
  kind: 'userMessage',
  text: '对方发来的话',
  attachments: [],
  peer: { name: '别的会话', session: null, bypass: false },
})
const wrapUp = (id) => ({ ...read(id), tool: 'wrap_up', wrapUp: { suggestions: [] } })
/** Claude 经理的事件回合（形状照真实经理会话，内容虚构）：消息 → 工具 →（中途一段话 → 工具）→ 空收尾 → 结尾一段话 */
const claudeEvent = (id, mid = false) => [
  id,
  [
    id.startsWith('p') ? peer(`${id}-u`) : report(`${id}-u`),
    read(`${id}-read`),
    ...(mid ? [answer(`${id}-mid`), read(`${id}-start`)] : []),
    read(`${id}-send`),
    wrapUp(`${id}-wrap`),
    answer(`${id}-end`),
  ],
]

test('Claude 经理连续 5 个带结尾文字的事件回合：一行标题，只露最后一段结尾文字和它的状态行', () => {
  const view = viewOf([
    claudeEvent('e1'),
    claudeEvent('p2'),
    claudeEvent('e3', true),
    claudeEvent('e4'),
    claudeEvent('p5'),
  ])
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.deepEqual(shape(rows), ['run:e1', 'md:p5', 'status:p5'])
  assert.deepEqual(rows[0].messages, [
    { kind: 'report', n: 3 },
    { kind: 'message', n: 2 },
  ])
  assert.equal(rows[0].steps, 11)
  assert.equal(rows[1].itemId, 'p5-end')
  // 展开：每个回合的消息、过程、中途文字、结尾文字和状态行按时间排
  builder.toggle('e1:run', 'e1')
  const open = shape(builder.build(view, new Set(['e1'])))
  assert.deepEqual(
    open.filter((entry) => entry.endsWith(':e3')),
    ['event:e3', 'group:e3', 'md:e3', 'group:e3', 'md:e3', 'status:e3'],
  )
  assert.equal(open.filter((entry) => entry.startsWith('status')).length, 5)
})

test('中间夹着用户的话：前后切开；块里最后几个回合没写字时，露的是块里最近写的那一段', () => {
  const view = viewOf([
    ['r1', [report('r1-u'), read('r1-c')]],
    ['u1', [user('u1-u'), read('u1-c'), answer('u1-a')]],
    ['r2', [report('r2-u'), read('r2-c'), answer('r2-a')]],
    ['r3', [report('r3-u'), read('r3-c')]],
  ])
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(shape(rows), [
    'run:r1',
    'user:u1',
    'process:u1',
    'group:u1',
    'md:u1',
    'status:u1',
    'run:r2',
    'md:r2',
    'status:r2',
  ])
})

test('正在跑的系统回合照常实时画；结束后并进前面的块', () => {
  const builder = new RowBuilder()
  const running = viewOf([
    ['r1', [report('r1-u'), read('r1-c')]],
    ['r2', [report('r2-u'), read('r2-c')], 'running'],
  ])
  const live = builder.build(running, 'all')
  assert.deepEqual(shape(live), ['run:r1', 'event:r2', 'group:r2', 'status:r2'])
  const done = viewOf([
    ['r1', [report('r1-u'), read('r1-c')]],
    ['r2', [report('r2-u'), read('r2-c')]],
  ])
  const rows = builder.build(done, new Set(['r2']))
  assert.deepEqual(shape(rows), ['run:r1'])
  assert.deepEqual(rows[0].messages, [{ kind: 'report', n: 2 }])
})
