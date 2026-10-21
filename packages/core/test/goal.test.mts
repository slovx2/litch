// 持续目标（协议原有的 thread/goal/*，harness 声明 features.goals）：打开会话时取目标、通知改目标、
// 界面的命令转成 thread/goal/set、clear；没声明的 harness 不问也不出入口；原生 codex 关了这个特性的记成不会
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  reduceSession,
  type SessionView,
  serveChannel,
} from '../src/index.mjs'
import { GOAL_CONTINUE_MS, GOAL_ROUND_TOKENS, GOAL_ROUNDS } from '../src/mock/mock-goal.mjs'
import { goalPursuing, goalStalled, projectGoal } from '../src/projection/goal.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const goal = (fields: Record<string, unknown> = {}) => ({
  threadId: 'a',
  objective: '把测试全跑通',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 300,
  timeUsedSeconds: 12,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  ...fields,
})

const settleMany = async (times = 4) => {
  for (let i = 0; i < times; i++) await settle()
}

test('GOAL-CORE-001 目标的投影：时间换成毫秒，形状不对的当没有；在做、停下要人看的分得清', () => {
  assert.deepEqual(projectGoal(goal({ tokenBudget: 5000 })), {
    objective: '把测试全跑通',
    status: 'active',
    tokenBudget: 5000,
    tokensUsed: 300,
    timeUsedSeconds: 12,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
  })
  assert.equal(projectGoal(null), null)
  assert.equal(projectGoal(goal({ objective: '' })), null)
  assert.equal(projectGoal(goal({ status: 'thinking' })), null)
  assert.equal(projectGoal(goal({ tokenBudget: 0 }))?.tokenBudget, null)
  assert.equal(goalPursuing(projectGoal(goal())), true)
  assert.equal(goalPursuing(projectGoal(goal({ status: 'paused' }))), false)
  assert.equal(goalStalled(projectGoal(goal({ status: 'budgetLimited' }))), true)
  assert.equal(goalStalled(projectGoal(goal({ status: 'complete' }))), false)
})

test('GOAL-CORE-002 声明了 goals：打开时取目标，通知改、清，命令转成 thread/goal/set、clear 并带 origin user', async () => {
  const codex = harness('codex', {
    declaration: { features: features({ goals: true }) },
    threads: [thread({ id: 'a', turns: [turn('t1', [userText('u1', '开工')])] })],
  })
  let current: ReturnType<typeof goal> | null = goal()
  const world = deviceWorld([codex], {
    extra: {
      'thread/goal/get': () => ({ goal: current }),
      'thread/goal/set': (params) => {
        const { objective, status } = params as { objective?: string; status?: string }
        current = goal({ ...(objective ? { objective } : {}), ...(status ? { status } : {}) })
        return { goal: current }
      },
      'thread/goal/clear': () => {
        current = null
        return { cleared: true }
      },
    },
  })
  world.core.start()
  await settleMany()
  const watched = watchSession(world.core, 'a')
  await settleMany()
  assert.equal(watched.seen.view?.can.goals, true)
  assert.equal(watched.seen.view?.goal?.objective, '把测试全跑通')
  assert.deepEqual(world.sent('thread/goal/get'), [{ threadId: 'a' }])

  // 别处（模型、别的客户端、用量记账）改了：整个换掉
  world.peer.last().notify('thread/goal/updated', {
    threadId: 'a',
    turnId: 't1',
    goal: goal({ status: 'complete', tokensUsed: 900 }),
  })
  await settle()
  assert.equal(watched.seen.view?.goal?.status, 'complete')
  assert.equal(watched.seen.view?.goal?.tokensUsed, 900)

  await world.command('session.goal.set', { sessionId: 'a', objective: '  再加一个用例  ' })
  await world.command('session.goal.set', { sessionId: 'a', status: 'paused', tokenBudget: null })
  assert.deepEqual(world.sent('thread/goal/set'), [
    { threadId: 'a', origin: 'user', objective: '再加一个用例' },
    { threadId: 'a', origin: 'user', status: 'paused', tokenBudget: null },
  ])
  await assert.rejects(
    world.command('session.goal.set', { sessionId: 'a', objective: '   ' }),
    (error: unknown) => error instanceof ChannelError && error.code === 'rejected',
  )

  await world.command('session.goal.clear', { sessionId: 'a' })
  assert.deepEqual(world.sent('thread/goal/clear'), [{ threadId: 'a', origin: 'user' }])
  await settle()
  assert.equal(watched.seen.view?.goal, null, '清掉了：对面不发通知这边也收掉')

  world.peer.last().notify('thread/goal/updated', { threadId: 'a', turnId: null, goal: goal() })
  await settle()
  const now = () => watched.seen.view?.goal
  assert.equal(now()?.status, 'active')
  world.peer.last().notify('thread/goal/cleared', { threadId: 'a' })
  await settle()
  assert.equal(watched.seen.view?.goal, null)
  watched.close()
})

test('GOAL-CORE-003 没声明 goals 的不问、命令报不支持；声明了却关着这个特性的，记成不会', async () => {
  const pi = harness('pi', {
    declaration: { features: features() },
    threads: [thread({ id: 'a', turns: [turn('t1', [userText('u1', '开工')])] })],
  })
  const world = deviceWorld([pi])
  world.core.start()
  await settleMany()
  const watched = watchSession(world.core, 'a')
  await settleMany()
  assert.equal(watched.seen.view?.can.goals, false)
  assert.equal(watched.seen.view?.goal ?? null, null)
  assert.deepEqual(world.sent('thread/goal/get'), [])
  await assert.rejects(
    world.command('session.goal.set', { sessionId: 'a', objective: '试试' }),
    (error: unknown) => error instanceof ChannelError && error.code === 'unsupported',
  )
  watched.close()

  // 原生 codex 的配置里关了 goals：声明说会（设备进程按默认报），调用时才知道
  const codex = harness('codex', {
    declaration: { features: features({ goals: true }) },
    threads: [thread({ id: 'b', turns: [turn('t1', [userText('u1', '开工')])] })],
  })
  const off = deviceWorld([codex], {
    extra: {
      'thread/goal/get': () => {
        throw new RpcFailure(-32600, 'goals feature is disabled')
      },
    },
  })
  off.core.start()
  await settleMany()
  const second = watchSession(off.core, 'b')
  await settleMany()
  assert.equal(second.seen.view?.goal ?? null, null)
  assert.equal(second.seen.view?.can.goals, false, '关着的记成不会，入口跟着收起')
  second.close()
})

test('GOAL-CORE-004 模拟：设下目标后空闲时自己续跑（来历 goal、没有用户消息），第三轮报做完；暂停不再续跑；预算用完停在 budgetLimited', async () => {
  const time = fakeClock(1_700_000_000_000)
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 0 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const state = { view: null as SessionView | null }
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 'k1' },
    {
      snapshot: (data) => {
        state.view = data
      },
      delta(ops) {
        for (const op of ops) if (state.view) reduceSession(state.view, op)
      },
      error() {},
    },
  )
  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 400 && !check(); i++) {
      time.advance(50)
      await settle()
    }
    assert.ok(check(), label)
  }
  const idle = () =>
    state.view !== null && state.view.turns.every((entry) => entry.status !== 'running')
  const call = (name: 'session.goal.set' | 'session.goal.clear', params: object) =>
    channel.command(name, { deviceId: 'local', sessionId: 'k1', ...params } as never)
  await until(idle, '会话载入了')
  assert.equal(state.view?.can.goals, true)
  const before = state.view?.turns.length ?? 0

  await call('session.goal.set', { objective: '整理发版说明' })
  await until(() => state.view?.goal?.status === 'complete', '第三轮报做完了')
  const added = state.view?.turns.slice(before) ?? []
  assert.equal(added.length, GOAL_ROUNDS)
  assert.ok(added.every((entry) => entry.origin === 'goal'))
  assert.ok(
    added.every((entry) =>
      entry.itemIds.every((id) => state.view?.items[id]?.kind !== 'userMessage'),
    ),
    '续跑回合没有用户消息',
  )
  assert.equal(state.view?.goal?.tokensUsed, GOAL_ROUNDS * GOAL_ROUND_TOKENS)
  time.advance(GOAL_CONTINUE_MS * 3)
  await settle()
  assert.equal(state.view?.turns.length, before + GOAL_ROUNDS, '做完了就不再续跑')

  // 换一个新目标、带预算：一轮就用到了预算
  await call('session.goal.set', { objective: '再查一遍链接', tokenBudget: GOAL_ROUND_TOKENS })
  await until(() => state.view?.goal?.status === 'budgetLimited', '预算用完了')
  assert.equal(state.view?.goal?.objective, '再查一遍链接')
  await until(idle, '那一轮说完了')

  // 继续、马上暂停：不再续跑
  await call('session.goal.set', { status: 'active', tokenBudget: null })
  await call('session.goal.set', { status: 'paused' })
  const paused = state.view?.turns.length
  time.advance(GOAL_CONTINUE_MS * 3)
  await settle()
  assert.equal(state.view?.turns.length, paused)
  assert.equal(state.view?.goal?.status, 'paused')

  await call('session.goal.clear', {})
  await until(() => state.view?.goal === null, '清掉了')
})

test('GOAL-CORE-005 续跑回合的来历：入口带着 goal 的不画那句内部提示；原生 codex 不带的，会话有目标、没有用户消息的认成 goal', async () => {
  const codex = harness('codex', {
    declaration: { features: features({ goals: true }) },
    threads: [
      thread({
        id: 'a',
        turns: [
          turn('t1', [userText('u1', '开工'), agentText('m1', '好')]),
          // 原生 codex 的续跑：没有用户消息
          turn('t2', [agentText('m2', '接着做')]),
          // Claude 入口的续跑：带来历，那句“接着做”是入口说的
          {
            ...turn('t3', [userText('u3', '继续执行当前持续目标'), agentText('m3', '做完了')]),
            litchOrigin: 'goal',
          } as never,
        ],
      }),
    ],
  })
  const world = deviceWorld([codex], {
    extra: { 'thread/goal/get': () => ({ goal: goal() }) },
  })
  world.core.start()
  await settleMany()
  const watched = watchSession(world.core, 'a')
  await settleMany()
  const view = () => watched.seen.view
  assert.deepEqual(
    view()?.turns.map((entry) => entry.origin ?? null),
    [null, 'goal', 'goal'],
  )
  const kinds = (turnId: string) =>
    view()
      ?.turns.find((entry) => entry.id === turnId)
      ?.itemIds.map((id) => view()?.items[id]?.kind)
  assert.deepEqual(kinds('t3'), ['agentMessage'], '入口说的那句不画成用户消息')

  // 看着一个续跑回合跑完：结束时认出来
  world.peer
    .last()
    .notify('turn/started', { threadId: 'a', turn: turn('t4', [], { status: 'inProgress' }) })
  world.peer.last().notify('item/completed', {
    threadId: 'a',
    turnId: 't4',
    item: agentText('m4', '又推进了一步'),
  })
  world.peer.last().notify('turn/completed', { threadId: 'a', turn: turn('t4', []) })
  await settle()
  assert.equal(view()?.turns.at(-1)?.origin, 'goal')

  // 入口带着来历开的回合：后到的那句内部提示也不画
  world.peer.last().notify('turn/started', {
    threadId: 'a',
    turn: { ...turn('t5', [], { status: 'inProgress' }), litchOrigin: 'goal' } as never,
  })
  world.peer.last().notify('item/started', {
    threadId: 'a',
    turnId: 't5',
    item: userText('u5', '继续执行当前持续目标'),
  })
  await settle()
  assert.deepEqual(kinds('t5'), [])
  watched.close()
})

test('GOAL-CORE-006 目标在做时按停止：先暂停目标再打断；目标停着的照常只打断', async () => {
  const codex = harness('codex', {
    declaration: { features: features({ goals: true }) },
    threads: [
      thread({
        id: 'a',
        turns: [turn('t1', [userText('u1', '开工')], { status: 'inProgress' })],
      }),
    ],
  })
  let current = goal()
  const world = deviceWorld([codex], {
    extra: {
      'thread/goal/get': () => ({ goal: current }),
      'thread/goal/set': (params) => {
        current = goal({ status: (params as { status: string }).status })
        return { goal: current }
      },
    },
  })
  world.core.start()
  await settleMany()
  const watched = watchSession(world.core, 'a')
  await settleMany()
  assert.equal(watched.seen.view?.turns.at(-1)?.status, 'running')
  await world.command('session.interrupt', { sessionId: 'a' })
  const order = world.peer
    .last()
    .seen.map((entry) => entry.method)
    .filter((method) => method === 'thread/goal/set' || method === 'turn/interrupt')
  assert.deepEqual(order, ['thread/goal/set', 'turn/interrupt'])
  assert.equal(world.sent('thread/goal/set')[0]?.status, 'paused')
  assert.equal(world.sent('thread/goal/set')[0]?.origin, 'user')

  // 目标已经停着：不再去暂停
  world.peer.last().notify('thread/goal/updated', {
    threadId: 'a',
    turnId: null,
    goal: goal({ status: 'paused' }),
  })
  await settle()
  await world.command('session.interrupt', { sessionId: 'a' })
  assert.equal(world.sent('thread/goal/set').length, 1)
  assert.equal(world.sent('turn/interrupt').length, 2)
  watched.close()
})

test('GOAL-CORE-007 新建会话时第一句是目标：建好就设目标、不发消息；harness 不会的不去建', async () => {
  const codex = harness('codex', { declaration: { features: features({ goals: true }) } })
  const pi = harness('pi', { declaration: { features: features() } })
  const world = deviceWorld([codex, pi], {
    extra: { 'thread/goal/set': () => ({ goal: goal() }) },
  })
  world.core.start()
  await settleMany()
  const { sessionId } = (await world.command('session.create', {
    harness: 'codex',
    cwd: '/work',
    text: '  把测试全跑通  ',
    goal: true,
  })) as { sessionId: string }
  assert.ok(sessionId)
  assert.equal(world.sent('thread/start').length, 1)
  assert.deepEqual(world.sent('thread/goal/set'), [
    { threadId: sessionId, origin: 'user', objective: '把测试全跑通' },
  ])
  assert.equal(world.sent('turn/start').length, 0, '不发第一条消息')

  await assert.rejects(
    world.command('session.create', { harness: 'pi', cwd: '/work', text: '试试', goal: true }),
    (error: unknown) => error instanceof ChannelError && error.code === 'unsupported',
  )
  assert.equal(world.sent('thread/start').length, 1, '不会的不去建会话')
})
