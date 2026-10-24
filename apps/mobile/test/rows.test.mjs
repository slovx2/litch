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
const notice = (id) => ({ id, kind: 'notice', label: '进入审查模式', detail: null })

function viewOf(turns, items) {
  return {
    forkedFrom: null,
    proposals: [],
    requests: [],
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

test('状态行在回合跑时写“正在工作”：只在正文出字、等人答复时留空，步骤在跑照写', () => {
  const working = (items, requests = []) => {
    const view = viewOf(
      [{ id: 't', status: 'running', itemIds: items.map((item) => item.id) }],
      items,
    )
    view.requests = requests
    return new RowBuilder().build(view, 'all').at(-1).working
  }
  assert.equal(working([user('u', '跑')]), true)
  assert.equal(working([user('u', '跑'), answer('a', '先看看')]), true)
  assert.equal(working([user('u', '跑'), answer('a', '正在写', 'inProgress')]), false)
  assert.equal(working([user('u', '跑'), { ...command('c'), status: 'inProgress' }]), true)
  assert.equal(working([user('u', '跑')], [{ id: 'r', kind: 'approval' }]), false)
  const done = viewOf([{ id: 't', status: 'completed', itemIds: ['u'] }], [user('u', '跑')])
  assert.equal(new RowBuilder().build(done, 'all').at(-1).working, false)
})

test('展开一组：摘要在前，每一步各一行排在它后面，最后一行“收起”（倒置后往下展开）', () => {
  const items = [user('u', '跑'), { ...command('c1'), status: 'completed', exitCode: 0 }]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: ['u', 'c1'] }], items)
  const builder = new RowBuilder()
  const group = builder.build(view, 'all')[1]
  builder.expanded.add(group.key)
  const rows = builder.build(view, new Set(['t']))
  assert.deepEqual(types(rows), ['user', 'group', 'step', 'groupEnd', 'status'])
  assert.equal(rows[1].expanded, true)
  assert.equal(rows[2].output, 'c1 的输出')
  assert.equal(rows[2].state, 'done')
  assert.equal(rows[3].group, group.key)
  // 收起：摘要还是原来那个键，步骤和“收起”都没了
  builder.expanded.delete(group.key)
  const folded = builder.build(view, new Set(['t']))
  assert.deepEqual(types(folded), ['user', 'group', 'status'])
  assert.equal(folded[1].key, group.key)
})

/** 启动子代理、等待子代理的协作调用（核心投影出来的样子） */
const collab = (id, tool, agents, status = 'completed') => ({
  id,
  kind: 'toolCall',
  source: { key: 'collab.source' },
  tool: { key: `collab.${tool}` },
  status,
  input: tool === 'spawnAgent' ? [{ kind: 'text', text: '分头查三件事。第一件看目录' }] : [],
  output: [],
  error: null,
  durationMs: null,
  agents,
})

test('启动子代理不进过程组，单独一行；等待还是组里的一步', () => {
  const spawn = collab('sp', 'spawnAgent', [
    { threadId: 'a1', state: 'running', message: null },
    { threadId: 'a2', state: 'running', message: null },
    { threadId: 'a3', state: 'running', message: null },
  ])
  const wait = collab('w', 'wait', [
    { threadId: 'a1', state: 'completed', message: null },
    { threadId: 'a2', state: 'interrupted', message: null },
    { threadId: 'a3', state: 'errored', message: null },
  ])
  const items = [user('u', '用子代理'), spawn, wait, answer('a', '都停下了')]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: ['u', 'sp', 'w', 'a'] }], items)
  view.agents = []
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'agents', 'group', 'md', 'status'])
  assert.equal(rows[1].item, spawn)
  // 子线程还没列出来：按等待那一条报的状态
  assert.equal(rows[1].states, 'completed stopped failed')
  assert.equal(rows[2].count, 1)
  assert.equal(rows[2].ids, 'w')
  // 子线程自己的回合优先：列表来了以后按它写
  view.agents = [
    {
      id: 'a1',
      status: 'idle',
      turn: { state: 'failed', startedAt: 1, durationMs: 5, error: 'x' },
    },
    { id: 'a2', status: 'running', turn: { state: 'running', startedAt: 1, durationMs: null } },
  ]
  const again = builder.build(view, new Set(['t']))
  assert.equal(again[1].states, 'failed running failed')
  assert.equal(again[1].threads, view.agents)
  // 内容没变的行复用同一个对象
  assert.equal(builder.build(view, new Set(['t']))[1], again[1])
})

test('启动子代理刚开始、还不知道派了谁：也是单独一行，没有状态', () => {
  const spawn = collab('sp', 'spawnAgent', [], 'inProgress')
  const items = [user('u', '用子代理'), command('c1', 'completed', 0), spawn]
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'c1', 'sp'] }],
    items.map((item) => (item.kind === 'command' ? { ...item, status: 'completed' } : item)),
  )
  view.agents = []
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'agents', 'status'])
  assert.equal(rows[1].count, 1)
  assert.equal(rows[2].states, '')
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

test('后台任务：回合结束了还在跑的步骤不再写“正在做”，摘要带条目号给单元格数；自发回合开头一行在最前', () => {
  const view = viewOf(
    [
      { id: 't1', status: 'completed', itemIds: ['t1:u', 't1:c', 't1:a'] },
      { id: 't2', status: 'running', itemIds: ['t2:a'], origin: 'backgroundTask', startedAt: 9000 },
    ],
    [
      user('t1:u', '后台跑'),
      { ...command('t1:c'), status: 'inProgress' },
      answer('t1:a', '在后台跑着了'),
      answer('t2:a', '跑完了', 'inProgress'),
    ],
  )
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'md', 'status', 'origin', 'md', 'status'])
  const group = rows[1]
  assert.equal(group.current, null, '回合结束了：还 inProgress 的是后台命令，不当成正在做的一步')
  assert.equal(group.running, false)
  assert.equal(group.ended, true)
  assert.equal(group.ids, 't1:c')
  assert.deepEqual(rows[4], {
    type: 'origin',
    key: 't2:origin',
    turnId: 't2',
    origin: 'backgroundTask',
    startedAt: 9000,
  })
})

test('上下文压缩：一条单独的分隔行，不进过程组；压的时候状态行不写“正在工作”', () => {
  const compaction = (status, span) => ({
    id: 'k',
    kind: 'compaction',
    status,
    source: 'automatic',
    ...(span ? { span } : {}),
  })
  const running = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'c1', 'k'] }],
    [
      user('u', '接着做'),
      { ...command('c1'), status: 'completed' },
      compaction('inProgress', { from: 5, to: null }),
    ],
  )
  const rows = new RowBuilder().build(running, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'compaction', 'status'])
  assert.deepEqual(
    { status: rows[2].status, source: rows[2].source, startedAt: rows[2].startedAt },
    { status: 'inProgress', source: 'automatic', startedAt: 5 },
  )
  assert.equal(rows[3].working, false)
  const done = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['k'] }],
    [{ ...compaction('completed'), source: 'manual' }],
  )
  const after = new RowBuilder().build(done, 'all')
  assert.deepEqual(types(after), ['compaction', 'status'])
  assert.deepEqual(
    [after[0].status, after[0].source, after[0].startedAt],
    ['completed', 'manual', null],
  )
})
