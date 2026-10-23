// 后台任务（backgroundTasks 扩展）：报集合的连接照会话对象上的 litchBackground 和变化通知投影到侧栏摘要；
// 不报的从已结束回合里还 inProgress 的命令派生；回合上的 litchOrigin 进 TurnView.origin
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  type ItemView,
  reduceSession,
  type SessionOp,
  type SessionSummary,
  type SessionView,
  type SidebarOp,
  serveChannel,
  type TurnView,
} from '../src/index.mjs'
import {
  backgroundHint,
  deriveBackground,
  projectBackground,
  projectOrigin,
  runningFromTurn,
  sessionBackground,
  taskOfItem,
  wokenBy,
} from '../src/projection/background.mjs'
import { projectTurn } from '../src/projection/session.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const commandItem = (id: string, status: 'inProgress' | 'completed'): ThreadItem =>
  ({
    type: 'commandExecution',
    id,
    command: `npm run ${id}`,
    cwd: '/work',
    pluginId: null,
    scriptPath: null,
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: '',
    exitCode: status === 'completed' ? 0 : null,
    durationMs: null,
  }) as ThreadItem

test('BG-CORE-001 集合的投影：形状不对的丢掉，不认识的种类当 other，空集合是 null；来历只认得出的', () => {
  assert.equal(projectBackground(undefined), null)
  assert.equal(projectBackground({ tasks: [], wakesOnFinish: true }), null)
  const view = projectBackground({
    tasks: [
      {
        id: 'a',
        kind: 'shell',
        title: 'npm run dev',
        status: 'running',
        itemId: 'i1',
        startedAt: 5,
      },
      { id: 'b', kind: 'mystery', title: 'x', status: 'completed', endedAt: 9 },
      { kind: 'shell', title: '没有标识' },
      null,
    ],
    wakesOnFinish: true,
  })
  assert.deepEqual(view, {
    tasks: [
      {
        id: 'a',
        kind: 'shell',
        title: 'npm run dev',
        status: 'running',
        itemId: 'i1',
        turnId: null,
        startedAt: 5,
        endedAt: null,
      },
      {
        id: 'b',
        kind: 'other',
        title: 'x',
        status: 'completed',
        itemId: null,
        turnId: null,
        startedAt: null,
        endedAt: 9,
      },
    ],
    running: 1,
    wakesOnFinish: true,
  })
  assert.equal(projectOrigin('backgroundTask'), 'backgroundTask')
  assert.equal(projectOrigin('schedule'), 'schedule')
  assert.equal(projectOrigin('user'), undefined)
  assert.equal(projectOrigin('whatever'), undefined)
  const woke = projectTurn({ ...turn('t2', []), litchOrigin: 'backgroundTask' } as never)
  assert.equal(woke.turn.origin, 'backgroundTask')
  assert.equal('origin' in projectTurn(turn('t3', [])).turn, false)
})

test('BG-CORE-002 退路派生：已结束回合里还 inProgress 的命令算在跑，进行中的回合不算；挂回回合、找叫醒它的任务', () => {
  const done = projectTurn(
    turn('local:1', [
      userText('u', '起服务'),
      commandItem('dev', 'inProgress'),
      commandItem('lint', 'completed'),
    ]),
  )
  const live = projectTurn(
    turn('t2', [commandItem('build', 'inProgress')], { status: 'inProgress' }),
  )
  const items: Record<string, ItemView> = {}
  for (const item of [...done.items, ...live.items]) items[item.id] = item
  const turns: TurnView[] = [done.turn, live.turn]
  const derived = deriveBackground(turns, items)
  assert.deepEqual(
    derived?.tasks.map((task) => [task.title, task.itemId, task.turnId, task.status]),
    [['npm run dev', 'dev', 'local:1', 'running']],
  )
  assert.equal(derived?.running, 1)
  assert.equal(derived?.wakesOnFinish, null)
  assert.equal(runningFromTurn(derived, done.turn), 1)
  assert.equal(runningFromTurn(derived, live.turn), 0)
  assert.equal(taskOfItem(derived, 'local:1:dev')?.title, 'npm run dev')
  assert.equal(taskOfItem(derived, 'local:1:lint'), null)
  // 报集合的照集合，派生的不用
  const reported = projectBackground({
    tasks: [
      { id: 'x', kind: 'shell', title: '先结束的', status: 'completed', endedAt: 1_000 },
      { id: 'y', kind: 'shell', title: '后结束的', status: 'failed', endedAt: 2_000 },
      { id: 'z', kind: 'shell', title: '还在跑', status: 'running', startedAt: 10 },
    ],
    wakesOnFinish: true,
  })
  assert.equal(sessionBackground(true, reported, turns, items), reported)
  assert.equal(sessionBackground(true, null, turns, items), null)
  assert.equal(sessionBackground(false, reported, turns, items)?.tasks[0]?.title, 'npm run dev')
  const woke: TurnView = { ...done.turn, startedAt: 2_100 }
  assert.equal(wokenBy(reported, woke)?.title, '后结束的')
  assert.equal(wokenBy(reported, { ...woke, startedAt: null }), null)
})

test('BG-CORE-003 设备：握手声明 backgroundTasks；集合挂在侧栏摘要上，变化通知整份替换；回合的来历进会话', async () => {
  const codex = harness('codex', {
    declaration: { features: features({ backgroundTasks: true }) },
    threads: [
      thread({
        id: 'a',
        updatedAt: 1_700_000_300,
        turns: [turn('t1', [userText('u1', '起服务')])],
        litchBackground: {
          tasks: [
            { id: 'k1', kind: 'shell', title: 'npm run dev', status: 'running', startedAt: 1 },
          ],
          wakesOnFinish: true,
        },
      } as never),
    ],
  })
  const world = deviceWorld([codex])
  world.core.start()
  for (let i = 0; i < 4; i++) await settle()
  const init = world.peer.last().seen.find((entry) => entry.method === 'initialize')
  assert.ok(init, '握手发出去了')
  const caps = (init.params as { capabilities: { litchExtensions: string[] } }).capabilities
  assert.ok(caps.litchExtensions.includes('backgroundTasks'))
  assert.equal(world.side.sessions.get('a')?.background?.running, 1)

  const watched = watchSession(world.core, 'a')
  await settle()
  assert.equal(watched.seen.view?.can.backgroundTasks, true)

  world.peer.last().notify('litch/thread/background/changed', {
    threadId: 'a',
    tasks: [
      {
        id: 'k1',
        kind: 'shell',
        title: 'npm run dev',
        status: 'completed',
        startedAt: 1,
        endedAt: 9,
      },
    ],
    wakesOnFinish: true,
  })
  await settle()
  const after = world.side.sessions.get('a')?.background
  assert.equal(after?.running, 0)
  assert.equal(after?.tasks[0]?.status, 'completed')

  // 后台任务结束后引擎自己开的那一轮：开始时没带来历的，结束时带来也认
  world.peer
    .last()
    .notify('turn/started', { threadId: 'a', turn: turn('t2', [], { status: 'inProgress' }) })
  await settle()
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: { ...turn('t2', []), litchOrigin: 'backgroundTask' },
  })
  await settle()
  const woke = watched.seen.view?.turns.find((entry) => entry.id === 't2')
  assert.equal(woke?.origin, 'backgroundTask')

  world.peer.last().notify('litch/thread/background/changed', {
    threadId: 'a',
    tasks: [],
    wakesOnFinish: true,
  })
  await settle()
  assert.equal(world.side.sessions.get('a')?.background, null)
  watched.close()
})

test('BG-CORE-004 模拟：说“后台任务”起两条后台命令，回合结束时两条在跑；先结束的叫醒会话，另一条后来失败', async () => {
  const time = fakeClock(1_700_000_000_000)
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 0 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const rows = new Map<string, SessionSummary>()
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        for (const entry of data.sessions) rows.set(entry.id, entry)
      },
      delta(ops: SidebarOp[]) {
        for (const op of ops) if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
      },
    },
  )
  const state = { view: null as SessionView | null }
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's1' },
    {
      snapshot: (data) => {
        state.view = structuredClone(data)
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (state.view) reduceSession(state.view, structuredClone(op))
      },
    },
  )
  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 400 && !check(); i++) {
      time.advance(50)
      await settle()
    }
    assert.ok(check(), label)
  }
  await settle()
  await channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's1',
    text: '起两个后台任务',
  })
  const background = () => {
    const view = state.view
    if (!view) return null
    return sessionBackground(
      view.can.backgroundTasks,
      rows.get('s1')?.background ?? null,
      view.turns,
      view.items,
    )
  }
  await until(() => state.view?.turns.at(-1)?.status === 'completed', '回合说完了')
  assert.equal(rows.get('s1')?.status, 'idle')
  assert.equal(background()?.running, 2)
  const started = state.view?.turns.at(-1)
  assert.ok(started)
  assert.equal(runningFromTurn(background(), started), 2)
  // 不报集合的连接也派生得出同样两条
  assert.equal(deriveBackground(state.view?.turns ?? [], state.view?.items ?? {})?.running, 2)

  await until(() => state.view?.turns.at(-1)?.origin === 'backgroundTask', '测试跑完叫醒了会话')
  const woke = state.view?.turns.at(-1)
  assert.ok(woke)
  assert.equal(
    woke.itemIds.some((id) => state.view?.items[id]?.kind === 'userMessage'),
    false,
  )
  assert.equal(wokenBy(background(), woke)?.title, 'npm test -- --reporter dot')
  assert.equal(background()?.running, 1)
  await until(() => background()?.running === 0, 'dev 服务也结束了')
  assert.deepEqual(
    background()?.tasks.map((task) => [task.title, task.status]),
    [
      ['npm run dev', 'failed'],
      ['npm test -- --reporter dot', 'completed'],
    ],
  )
})

test('BG-CORE-005 后台任务还在跑时人接着说话：新回合进行中，集合和输入框上方那一行照样数着它们', async () => {
  const time = fakeClock(1_700_000_000_000)
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 40 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const rows = new Map<string, SessionSummary>()
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        for (const entry of data.sessions) rows.set(entry.id, entry)
      },
      delta(ops: SidebarOp[]) {
        for (const op of ops) if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
      },
    },
  )
  const state = { view: null as SessionView | null }
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's1' },
    {
      snapshot: (data) => {
        state.view = structuredClone(data)
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (state.view) reduceSession(state.view, structuredClone(op))
      },
    },
  )
  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 400 && !check(); i++) {
      time.advance(20)
      await settle()
    }
    assert.ok(check(), label)
  }
  const send = (text: string) =>
    channel.command('session.send', { deviceId: 'local', sessionId: 's1', text })
  // 报集合的照摘要，不报的照会话派生：两条路都要数得出
  const reported = () => backgroundHint(rows.get('s1')?.background ?? null)
  const derived = () =>
    backgroundHint(deriveBackground(state.view?.turns ?? [], state.view?.items ?? {}))
  // 等的是 n 个回合之后新起的那个回合（样例会话里本来就有说完了的回合）
  const turnAfter = (n: number, status: string) => () =>
    (state.view?.turns.length ?? 0) > n && state.view?.turns.at(-1)?.status === status
  // 样例会话载入时最后一个回合还在流：等它说完再发，免得消息排进队里
  await until(
    () => state.view !== null && state.view.turns.at(-1)?.status !== 'running',
    '会话载入了、空闲',
  )
  const first = state.view?.turns.length ?? 0
  await send('起两个后台任务')
  await until(turnAfter(first, 'completed'), '回合说完了')
  assert.equal(reported(), 2)
  assert.equal(derived(), 2)
  const before = state.view?.turns.length ?? 0

  await send('趁它们跑着，再说一句')
  await until(turnAfter(before, 'running'), '新回合在跑')
  assert.equal(rows.get('s1')?.status, 'running')
  assert.equal(reported(), 2, '新回合进行中，摘要上的集合还数着两个')
  assert.equal(derived(), 2, '新回合进行中，上一回合留下的两条命令照样派生得出')
  await until(turnAfter(before, 'completed'), '新回合说完了')
  assert.equal(reported(), 2)
})
