// 手机上的持续目标：输入框里的 /goal 怎么处理、斜杠单子出不出（src/detail/goal/logic.ts），
// 达成那一句排在哪（src/core/rows.ts），接在模拟核心上从设目标到达成（会话存储的 meta.goal 和行）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { RowBuilder } from '../src/core/rows.ts'
import { SessionStore } from '../src/core/session-store.ts'
import { goalIntent, slashGoalShown } from '../src/detail/goal/logic.ts'
import { experiment } from '../src/experiment.ts'
import { mockChannel, until } from './helpers.mjs'

experiment.seal = 300

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

const goal = (fields = {}) => ({
  objective: '把测试全跑通',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
})

test('/goal 的处理：不会目标、不是 /goal 的照常发；没写字、带附件的不收；换掉没做完的先问', () => {
  assert.deepEqual(goalIntent('/goal 跑通', 0, false, null), { kind: 'send' }, 'harness 不会')
  assert.deepEqual(goalIntent('/goals 看看', 0, true, null), { kind: 'send' })
  assert.deepEqual(goalIntent('随便聊聊', 0, true, null), { kind: 'send' })
  assert.deepEqual(goalIntent('/goal   ', 0, true, null), { kind: 'refuse', key: 'goal.needText' })
  assert.deepEqual(goalIntent('/goal 跑通', 1, true, null), {
    kind: 'refuse',
    key: 'goal.textOnly',
  })
  assert.deepEqual(goalIntent('/goal  跑通 \n第二行', 0, true, null), {
    kind: 'goal',
    objective: '跑通 \n第二行',
  })
  assert.deepEqual(goalIntent('/goal 别的', 0, true, goal()), { kind: 'ask', objective: '别的' })
  assert.equal(goalIntent('/goal 把测试全跑通', 0, true, goal()).kind, 'goal', '一样的不问')
  assert.equal(goalIntent('/goal 别的', 0, true, goal({ status: 'paused' })).kind, 'ask')
})

test('斜杠单子：会目标、只打了 / 开头的一个词、是 /goal 的开头才出', () => {
  assert.equal(slashGoalShown('/', true), true)
  assert.equal(slashGoalShown('/go', true), true)
  assert.equal(slashGoalShown('/goal', true), true)
  assert.equal(slashGoalShown('/goal ', true), false, '已经写成 /goal 了')
  assert.equal(slashGoalShown('/gx', true), false)
  assert.equal(slashGoalShown('/goals', true), false)
  assert.equal(slashGoalShown('hi /go', true), false)
  assert.equal(slashGoalShown('/go', false), false, 'harness 不会')
})

test('达成那一句：排在达成它的回合最后一条回答下面、收尾卡片和状态行上面；回合在跑时不排', () => {
  const view = {
    forkedFrom: null,
    proposals: [],
    requests: [],
    turns: [
      {
        id: 't1',
        status: 'completed',
        itemIds: ['a1'],
        startedAt: null,
        durationMs: 10,
        error: null,
      },
      {
        id: 't2',
        status: 'completed',
        itemIds: ['a2', 'c', 'a3'],
        startedAt: null,
        durationMs: 10,
        error: null,
        origin: 'goal',
      },
    ],
    items: {
      a1: { id: 'a1', kind: 'agentMessage', text: '第一轮', phase: 'final', status: 'completed' },
      a2: { id: 'a2', kind: 'agentMessage', text: '先看看', phase: 'final', status: 'completed' },
      c: {
        id: 'c',
        kind: 'command',
        command: 'ls',
        cwd: '/w',
        output: '',
        elided: null,
        exitCode: 0,
        durationMs: 1,
        startedAt: null,
        status: 'completed',
      },
      a3: { id: 'a3', kind: 'agentMessage', text: '做完了', phase: 'final', status: 'completed' },
    },
    goalReached: { turnId: 't2', objective: '把测试全跑通', timeUsedSeconds: 125 },
  }
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(
    rows.map((row) => row.type),
    ['md', 'status', 'origin', 'md', 'group', 'md', 'goalReached', 'status'],
  )
  const line = rows.find((row) => row.type === 'goalReached')
  assert.equal(line.turnId, 't2')
  assert.equal(line.ms, 125_000)
  view.turns[1].status = 'running'
  assert.ok(!new RowBuilder().build(view, 'all').some((row) => row.type === 'goalReached'))
})

test('接在模拟核心上：设下目标 meta 里有它，续跑几轮达成后 meta 里没了、最后一轮回答下面一行用时', async () => {
  // 示例数据里 build-01 上那个空闲的原生 Codex 会话：持续目标只有它会
  const mock = mockChannel()
  const sessionId = 'b6'
  const store = new SessionStore(mock.channel, 'build', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  store.start()
  await until(() => store.getMeta()?.running === false, { what: '会话载入' })
  assert.equal(store.getMeta().can.goals, true)
  await mock.channel.command('session.goal.set', {
    deviceId: 'build',
    sessionId,
    objective: '整理发版说明',
    status: 'active',
  })
  await until(() => store.getMeta()?.goal?.status === 'active', { what: '目标进 meta' })
  const rows = await until(
    () => {
      const { rows } = store.getSnapshot()
      return rows.some((row) => row.type === 'goalReached') ? rows : null
    },
    { timeoutMs: 15_000, what: '达成那一句' },
  )
  assert.equal(store.getMeta().goal, null, '达成了马上清掉')
  // 新的在前：状态行、达成那一句、最后一轮的回答
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.type),
    ['status', 'goalReached', 'md'],
  )
  assert.ok(
    rows.some((row) => row.type === 'origin' && row.origin === 'goal'),
    '续跑回合开头那一行',
  )
  assert.equal(rows.filter((row) => row.type === 'goalReached').length, 1)
})
