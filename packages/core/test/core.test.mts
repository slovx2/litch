import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, Thread } from '../../protocol/src/index.mjs'
import {
  type AppOp,
  type AppView,
  type ChannelError,
  createCore,
  type SessionView,
  type SidebarOp,
  type SidebarView,
} from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { agentText, project, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

interface World {
  threads: Thread[]
  projects: Project[] | null
  /** runtime/info 回什么；null 表示对面不认识这个方法 */
  engine: 'pi' | 'claude-code' | null
  /** 不认识的方法回哪个错误码 */
  unknownCode: number
  /** 对面让不让订阅会话。不让的时候 thread/resume 报错，客户端应当退回到只取历史 */
  resumable: boolean
}

function setup(world: Partial<World> = {}) {
  const state: World = {
    threads: [],
    projects: [],
    engine: 'pi',
    unknownCode: -32601,
    resumable: true,
    ...world,
  }
  const unknown = (method: string) => {
    throw new RpcFailure(state.unknownCode, `unknown: ${method}`)
  }
  const handlers: Record<string, Handler> = {
    'runtime/info': () =>
      state.engine
        ? {
            engine: state.engine,
            protocolVersion: '0.163.0',
            cliBuild: '0.99.1',
            capabilities: [],
            releaseReady: true,
          }
        : unknown('runtime/info'),
    'project/list': () =>
      state.projects ? { data: state.projects, nextCursor: null } : unknown('project/list'),
    'thread/list': (params) => {
      // 每页两条，逼着客户端翻页
      const start = Number((params as { cursor?: string }).cursor ?? 0)
      const data = state.threads.slice(start, start + 2).map((entry) => ({ ...entry, turns: [] }))
      const next = start + 2 < state.threads.length ? String(start + 2) : null
      return { data, nextCursor: next, backwardsCursor: null }
    },
    'thread/read': (params) => {
      const { threadId, includeTurns } = params as { threadId: string; includeTurns?: boolean }
      const found = state.threads.find((entry) => entry.id === threadId)
      if (!found) throw new RpcFailure(-32600, `thread not found: ${threadId}`)
      return { thread: includeTurns ? found : { ...found, turns: [] } }
    },
    'thread/resume': (params) => {
      const { threadId } = params as { threadId: string }
      if (!state.resumable) throw new RpcFailure(-32603, 'engine is not installed')
      const found = state.threads.find((entry) => entry.id === threadId)
      if (!found) throw new RpcFailure(-32600, `thread not found: ${threadId}`)
      return { thread: found }
    },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const logs: string[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: (line) => logs.push(line),
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const app = { snapshots: [] as AppView[], ops: [] as AppOp[] }
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => app.snapshots.push(data as AppView),
      delta: (ops) => app.ops.push(...(ops as AppOp[])),
      error() {},
    },
  )
  const sidebar = { snapshots: [] as SidebarView[], ops: [] as SidebarOp[] }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => sidebar.snapshots.push(data as SidebarView),
      delta: (ops) => sidebar.ops.push(...(ops as SidebarOp[])),
      error() {},
    },
  )
  const device = () => {
    const last = app.ops.findLast((op) => op.op === 'device.upsert')
    return last?.op === 'device.upsert' ? last.device : app.snapshots[0]?.devices[0]
  }
  const latest = () => sidebar.snapshots[sidebar.snapshots.length - 1]
  return { core, state, peer, time, app, sidebar, device, latest, logs }
}

test('刚连上：认出对面，翻页取完全部会话，按工作区规则归好', async () => {
  const { core, app, sidebar, device, latest, peer } = setup({
    projects: [project('p', 'app', '/work/app')],
    threads: [
      thread({ id: 'a', cwd: '/work/app/web', preview: '改首页' }),
      thread({ id: 'b', cwd: '/tmp', name: '临时', status: { type: 'active', activeFlags: [] } }),
      thread({ id: 'c', cwd: '/other', projectId: 'p' }),
    ],
  })
  assert.equal(app.snapshots[0]?.devices[0]?.connection, 'offline')
  // 还没连上过：不知道对面是什么系统
  assert.equal(app.snapshots[0]?.devices[0]?.os, null)
  assert.deepEqual(sidebar.snapshots[0]?.sessions, [], '没连上之前侧栏是空的')

  core.start()
  await settle()
  const view = device()
  assert.equal(view?.connection, 'online')
  assert.equal(view?.mode, 'single')
  // 单个 harness 的入口：系统是握手应答里的 platformOs
  assert.equal(view?.os, 'macos')
  assert.deepEqual(
    view?.harnesses.map((entry) => [entry.id, entry.version]),
    [['pi', '0.99.1']],
  )

  const side = latest()
  assert.deepEqual(side?.workspaces, [
    { id: 'p', name: 'app', roots: ['/work/app'], color: null, pinned: false, sectionId: null },
  ])
  assert.deepEqual(
    side?.sessions.map((entry) => [
      entry.id,
      entry.workspaceId,
      entry.title,
      entry.status,
      entry.harness,
    ]),
    [
      ['a', 'p', '改首页', 'idle', 'pi'],
      ['b', null, '临时', 'running', 'pi'],
      ['c', 'p', { key: 'session.untitled' }, 'idle', 'pi'],
    ],
  )
  const pages = peer.last().seen.filter((entry) => entry.method === 'thread/list')
  assert.equal(pages.length, 2, '三条会话、每页两条，应该翻两页')
})

for (const code of [-32601, -32600]) {
  test(`对面是原生 codex（不认识的方法回 ${code}）：按单 harness 处理，没有工作区也能用`, async () => {
    const { core, device, latest, peer, time } = setup({
      engine: null,
      projects: null,
      unknownCode: code,
      threads: [thread({ id: 'a' })],
    })
    core.start()
    await settle()
    assert.deepEqual(
      device()?.harnesses.map((entry) => entry.id),
      ['codex'],
    )
    assert.equal(device()?.connection, 'online')
    assert.deepEqual(latest()?.workspaces, [])
    assert.deepEqual(
      latest()?.sessions.map((entry) => [entry.id, entry.workspaceId]),
      [['a', null]],
    )

    // “没有项目这组方法”记住了：重连之后不再问
    peer.last().drop()
    await settle()
    time.advance(500)
    await settle()
    assert.equal(device()?.connection, 'online')
    const asked = peer.last().seen.filter((entry) => entry.method === 'project/list')
    assert.equal(asked.length, 0)
  })
}

test('通知按白名单变成侧栏的增量；不认识的通知只记一次，不触发任何刷新', async () => {
  const { core, state, peer, sidebar, logs } = setup({
    projects: [project('p', 'app', '/work/app')],
    threads: [thread({ id: 'a', cwd: '/work/app' })],
  })
  core.start()
  await settle()
  const server = peer.last()
  const listed = () => server.seen.filter((entry) => entry.method === 'thread/list').length
  const before = listed()

  server.notify('thread/started', {
    thread: thread({ id: 'n', cwd: '/work/app', preview: '新的' }),
  })
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
  })
  server.notify('thread/name/updated', { threadId: 'a', threadName: '改了名' })
  server.notify('thread/project/updated', { threadId: 'n', projectId: null })
  server.notify('thread/archived', { threadId: 'n' })
  server.notify('account/updated', { threadId: 'a' })
  server.notify('account/updated', { threadId: 'a' })
  await settle()

  const ops = sidebar.ops.map((op) =>
    op.op === 'session.upsert'
      ? [op.op, op.session.id, op.session.title, op.session.status, op.session.waitingFor]
      : op.op === 'session.remove'
        ? [op.op, op.sessionId]
        : [op.op],
  )
  assert.deepEqual(ops, [
    ['session.upsert', 'n', '新的', 'idle', null],
    ['session.upsert', 'a', { key: 'session.untitled' }, 'waiting', 'answer'],
    ['session.upsert', 'a', '改了名', 'waiting', 'answer'],
    ['session.upsert', 'n', '新的', 'idle', null],
    ['session.remove', 'n'],
  ])
  assert.equal(listed(), before, '通知不该引起重新列目录')
  assert.equal(logs.filter((line) => line.includes('account/updated')).length, 1)

  // 目录里没有的会话来了状态通知：向对面要它的信息再放进侧栏
  state.threads.push(thread({ id: 'z', cwd: '/tmp', name: '别处开的' }))
  server.notify('thread/status/changed', { threadId: 'z', status: { type: 'idle' } })
  await settle()
  const last = sidebar.ops[sidebar.ops.length - 1]
  assert.ok(last?.op === 'session.upsert' && last.session.title === '别处开的')
})

test('工作区变了：重新取工作区，侧栏整体换一份', async () => {
  const { core, state, peer, sidebar, latest } = setup({
    projects: [],
    threads: [thread({ id: 'a', cwd: '/work/app' })],
  })
  core.start()
  await settle()
  assert.equal(latest()?.sessions[0]?.workspaceId, null)
  const count = sidebar.snapshots.length
  state.projects = [project('p', 'app', '/work')]
  peer.last().notify('project/changed', { projectId: 'p', changeType: 'created' })
  await settle()
  assert.equal(sidebar.snapshots.length, count + 1)
  assert.equal(latest()?.sessions[0]?.workspaceId, 'p')
})

/** 一个永远不取消的信号 */
const never = { aborted: false, addEventListener() {} }

function openSession(core: ReturnType<typeof setup>['core'], sessionId: string) {
  const seen = { snapshots: [] as SessionView[], errors: [] as ChannelError[] }
  const close = core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId },
    {
      snapshot: (data) => seen.snapshots.push(data as SessionView),
      delta() {},
      error: (error) => seen.errors.push(error),
    },
  )
  return { ...seen, close }
}

test('打开会话：取到带回合的内容；读不到时订阅以错误结束', async () => {
  const { core } = setup({
    threads: [
      thread({
        id: 'a',
        name: '有内容',
        turns: [turn('t1', [userText('1', '问'), agentText('2', '答')])],
      }),
    ],
  })
  core.start()
  await settle()
  const good = openSession(core, 'a')
  const bad = openSession(core, 'missing')
  await settle()
  assert.equal(good.snapshots.length, 1)
  assert.equal(good.snapshots[0]?.title, '有内容')
  assert.deepEqual(good.snapshots[0]?.turns[0]?.itemIds, ['t1:1', 't1:2'])
  assert.equal(good.snapshots[0]?.harness, 'pi')
  assert.equal(good.snapshots[0]?.live, true)
  assert.deepEqual(
    bad.errors.map((error) => [error.code, error.message]),
    [['remote', 'thread not found: missing']],
  )
})

test('打开会话：对面不让订阅时退回到只取历史，会话标成只读并说明原因', async () => {
  const { core, peer } = setup({
    resumable: false,
    threads: [thread({ id: 'a', turns: [turn('t1', [userText('1', '问')])] })],
  })
  core.start()
  await settle()
  const session = openSession(core, 'a')
  await settle()
  assert.equal(session.snapshots.length, 1)
  assert.equal(session.snapshots[0]?.live, false)
  assert.deepEqual(session.snapshots[0]?.note, {
    key: 'session.readOnly',
    args: { message: 'engine is not installed' },
  })
  assert.deepEqual(session.snapshots[0]?.turns[0]?.itemIds, ['t1:1'])
  // 只读的会话发不了消息，也不会去退订一个没订阅上的会话
  await assert.rejects(
    core.command('session.send', { deviceId: 'local', sessionId: 'a', text: '在吗' }, never),
    { code: 'rejected' },
  )
  session.close()
  await settle()
  assert.equal(
    peer.last().seen.some((entry) => entry.method === 'thread/unsubscribe'),
    false,
  )
})

test('打开会话：设备还没连上就等着；断线重连后以设备上的为准再取一遍', async () => {
  const { core, state, peer, time } = setup({
    threads: [thread({ id: 'a', turns: [turn('t1', [userText('1', '问')])] })],
  })
  const session = openSession(core, 'a')
  await settle()
  assert.equal(session.snapshots.length, 0)
  assert.equal(session.errors.length, 0)

  core.start()
  await settle()
  assert.equal(session.snapshots.length, 1)

  const first = state.threads[0]
  if (first) first.turns = [...first.turns, turn('t2', [userText('1', '又问')])]
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  assert.equal(session.snapshots.length, 2)
  assert.deepEqual(
    session.snapshots[1]?.turns.map((entry) => entry.id),
    ['t1', 't2'],
  )

  // 退订之后再重连，不再给它送内容
  session.close()
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  assert.equal(session.snapshots.length, 2)
})

test('命令：核心信息、手动刷新、对不存在的设备报错', async () => {
  const { core, state, latest } = setup({ threads: [thread({ id: 'a' })] })
  const signal = new AbortController().signal
  assert.deepEqual(await core.command('core.info', {}, signal), { version: '9.9.9', mock: false })
  core.start()
  await settle()
  state.threads.push(thread({ id: 'b' }))
  await core.command('device.refresh', { deviceId: 'local' }, signal)
  assert.deepEqual(
    latest()?.sessions.map((entry) => entry.id),
    ['a', 'b'],
  )
  await assert.rejects(core.command('device.refresh', { deviceId: 'nope' }, signal), {
    code: 'notFound',
  })
  await assert.rejects(core.command('nope', {}, signal), { code: 'unknownCommand' })
})
