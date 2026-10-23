// 工作树（worktrees 扩展）在核心这一头：握手声明、设备列了才能用；新建会话带 litchWorktree（起点、用第一句话起名）；
// 会话摘要上的 worktree 来自会话对象，跟着 litch/worktree/changed 变；worktrees 主题开着才读列表；
// 列分支时目录不在仓库里给 null；删、恢复的结果进列表。模拟核心同样能在新工作树里建会话。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Worktree } from '../../protocol/src/worktrees.mjs'
import {
  connectChannel,
  createCore,
  createMockCore,
  createPortPair,
  type SessionSummary,
  type SidebarOp,
  serveChannel,
  type WorktreesOp,
  type WorktreesTopicView,
} from '../src/index.mjs'
import { projectProposals } from '../src/projection/tree.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

const row = (fields: Partial<Worktree> = {}): Worktree => ({
  id: 'fix-login-3f2a1c',
  sourceRoot: '/repo',
  path: '/state/worktrees/repo/fix-login-3f2a1c',
  subPath: 'web',
  branch: 'litch/fix-login-3f2a1c',
  baseRef: 'main',
  baseCommit: 'abc123',
  ownerThreadId: null,
  state: 'ready',
  snapshotRef: null,
  createdAt: 100,
  updatedAt: 100,
  ...fields,
})

function world(options: { extensions?: string[] } = {}) {
  const fake = fakeDevice([harness('pi')])
  fake.device.extensions = options.extensions ?? ['harness', 'worktrees']
  const rows: Worktree[] = [row({ ownerThreadId: 'old' })]
  const start = fake.handlers['thread/start'] as (params: unknown) => { thread: object }
  const peer = fakeOpener({
    ...fake.handlers,
    // 设备建好工作树、换掉 cwd 再交给引擎：应答里的会话带着 litchWorktree
    'thread/start': (params) => {
      const fields = params as Record<string, unknown>
      if (!fields.litchWorktree) return start(params)
      const made = start({ ...fields, cwd: '/state/worktrees/repo/fix-login-3f2a1c/web' })
      const {
        ownerThreadId: _o,
        subPath: _s,
        snapshotRef: _r,
        createdAt: _c,
        updatedAt: _u,
        ...shown
      } = row()
      return { ...made, thread: { ...made.thread, litchWorktree: shown } }
    },
    'litch/worktree/list': () => ({ data: rows }),
    'litch/worktree/branches': (params) => {
      if ((params as { cwd: string }).cwd !== '/repo')
        throw new RpcFailure(-32602, '不在 git 仓库里')
      return {
        current: 'main',
        defaultBranch: 'main',
        local: ['main', 'dev'],
        remote: ['origin/main'],
      }
    },
    'litch/worktree/remove': (params) => {
      const { id, withBranch } = params as { id: string; withBranch?: boolean }
      const removed = row({
        id,
        ownerThreadId: 'old',
        state: 'removed',
        snapshotRef: withBranch ? null : `refs/litch/snapshots/${id}`,
      })
      return { worktree: removed }
    },
  })
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'dev',
        name: 'build-01',
        host: 'dev@build-01',
        kind: 'ssh',
        target: { kind: 'alias', alias: 'build-01' },
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'dev', ...params }, never)
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const sessions = new Map<string, SessionSummary>()
  core.subscribe(
    { kind: 'sidebar', deviceId: 'dev' },
    {
      snapshot: (data) => {
        for (const entry of (data as { sessions: SessionSummary[] }).sessions)
          sessions.set(entry.id, entry)
      },
      delta: (ops) => {
        for (const op of ops as SidebarOp[])
          if (op.op === 'session.upsert') sessions.set(op.session.id, op.session)
      },
      error() {},
    },
  )
  const watch = () => {
    const seen = { view: null as WorktreesTopicView | null }
    const close = core.subscribe(
      { kind: 'worktrees', deviceId: 'dev' },
      {
        snapshot: (data) => {
          seen.view = data as WorktreesTopicView
        },
        delta: (ops) => {
          for (const op of ops as WorktreesOp[]) seen.view = op.view
        },
        error() {},
      },
    )
    return { seen, close }
  }
  return { core, peer, command, sent, broadcast, sessions, watch, rows }
}

async function started(options: { extensions?: string[] } = {}) {
  const w = world(options)
  w.core.start()
  await settle()
  await settle()
  return w
}

test('WT-CORE-001：握手声明 worktrees；新建会话带 litchWorktree（起点、第一句话起名），摘要上有 worktree', async () => {
  const w = await started()
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')
  const caps = (init?.params as { capabilities: { litchExtensions: string[] } } | undefined)
    ?.capabilities ?? { litchExtensions: [] }
  assert.ok(caps.litchExtensions.includes('worktrees'))
  const { sessionId } = (await w.command('session.create', {
    harness: 'pi',
    cwd: '/repo/web',
    text: 'Fix the login page\n还有别的',
    worktree: { from: { kind: 'branch', branch: 'dev' } },
  })) as { sessionId: string }
  const [asked] = w.sent('thread/start')
  assert.equal(asked?.cwd, '/repo/web')
  assert.deepEqual(asked?.litchWorktree, {
    from: { kind: 'branch', branch: 'dev' },
    title: 'Fix the login page',
  })
  await settle()
  const summary = w.sessions.get(sessionId)
  assert.equal(summary?.cwd, '/state/worktrees/repo/fix-login-3f2a1c/web')
  assert.deepEqual(summary?.worktree, {
    id: 'fix-login-3f2a1c',
    path: '/state/worktrees/repo/fix-login-3f2a1c',
    branch: 'litch/fix-login-3f2a1c',
    baseRef: 'main',
    baseCommit: 'abc123',
    state: 'ready',
    sourceRoot: '/repo',
  })
  // 不要工作树的照旧，不带这个参数
  await w.command('session.create', { harness: 'pi', cwd: '/repo', text: 'plain' })
  assert.equal('litchWorktree' in (w.sent('thread/start')[1] ?? {}), false)
  // 工作树删了：主人会话上的状态跟着变
  w.broadcast('litch/worktree/changed', {
    worktree: row({
      ownerThreadId: sessionId,
      state: 'removed',
      snapshotRef: 'refs/litch/snapshots/x',
    }),
  })
  await settle()
  assert.equal(w.sessions.get(sessionId)?.worktree?.state, 'removed')
  // 连分支一起删掉了：会话上不再有
  w.broadcast('litch/worktree/changed', {
    worktree: row({ ownerThreadId: sessionId, state: 'removed' }),
    deleted: true,
  })
  await settle()
  assert.equal(w.sessions.get(sessionId)?.worktree, null)
})

test('WT-CORE-002：主题开着才读列表（时间换成毫秒）；变化通知、删除的结果进列表；列分支时不在仓库里给 null', async () => {
  const w = await started()
  assert.equal(w.sent('litch/worktree/list').length, 0, '没人看不读')
  const { seen } = w.watch()
  await settle()
  await settle()
  assert.equal(seen.view?.available, true)
  assert.equal(seen.view?.list?.[0]?.ownerSessionId, 'old')
  assert.equal(seen.view?.list?.[0]?.createdAt, 100_000)
  w.broadcast('litch/worktree/changed', {
    worktree: row({ id: 'second', createdAt: 200, updatedAt: 200 }),
  })
  await settle()
  assert.deepEqual(
    seen.view?.list?.map((entry) => entry.id),
    ['second', 'fix-login-3f2a1c'],
  )
  const { worktree } = (await w.command('worktree.remove', { id: 'second' })) as {
    worktree: { state: string; snapshotRef: string | null }
  }
  assert.equal(worktree.state, 'removed')
  assert.equal(
    seen.view?.list?.find((entry) => entry.id === 'second')?.snapshotRef,
    'refs/litch/snapshots/second',
  )
  await w.command('worktree.remove', { id: 'second', withBranch: true })
  assert.deepEqual(w.sent('litch/worktree/remove').at(-1), { id: 'second', withBranch: true })
  assert.deepEqual(
    seen.view?.list?.map((entry) => entry.id),
    ['fix-login-3f2a1c'],
  )
  const repo = (await w.command('worktree.branches', { cwd: '/repo' })) as {
    branches: { local: string[] } | null
  }
  assert.deepEqual(repo.branches?.local, ['main', 'dev'])
  const plain = (await w.command('worktree.branches', { cwd: '/tmp' })) as { branches: unknown }
  assert.equal(plain.branches, null)
})

test('WT-CORE-003：设备没列 worktrees：主题 available 为假，命令和带工作树的新建以 unsupported 结束', async () => {
  const w = await started({ extensions: ['harness'] })
  const { seen } = w.watch()
  assert.equal(seen.view?.available, false)
  await assert.rejects(w.command('worktree.branches', { cwd: '/repo' }), { code: 'unsupported' })
  await assert.rejects(
    w.command('session.create', { harness: 'pi', cwd: '/repo', text: 'x', worktree: {} }),
    { code: 'unsupported' },
  )
  assert.equal(w.sent('thread/start').length, 0)
})

test('WT-CORE-004 模拟：在新工作树里建会话，会话目录在工作树里、摘要带 worktree；工作区之外的目录建不了', async () => {
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
  time.advance(50)
  await settle()
  assert.equal(rows.get('s4')?.worktree?.branch, 'litch/sidebar-tweaks-3f2a1c')
  const branches = await channel.command('worktree.branches', {
    deviceId: 'local',
    cwd: '~/work/litch',
  })
  assert.equal(branches.branches?.defaultBranch, 'main')
  const outside = await channel.command('worktree.branches', {
    deviceId: 'local',
    cwd: '/elsewhere',
  })
  assert.equal(outside.branches, null)
  const { sessionId } = await channel.command('session.create', {
    deviceId: 'local',
    harness: 'claude',
    workspaceId: 'litch',
    cwd: '~/work/litch',
    text: 'Try the new layout',
    worktree: { from: { kind: 'working-tree' } },
  })
  // 通道按时钟成批送增量：走几步时钟
  for (let i = 0; i < 20 && !rows.get(sessionId)?.worktree; i++) {
    time.advance(50)
    await settle()
  }
  const made = rows.get(sessionId)
  assert.match(made?.worktree?.branch ?? '', /^litch\/try-the-new-layout-[0-9a-f]{6}$/)
  assert.equal(made?.worktree?.baseRef, 'working-tree')
  assert.equal(made?.cwd, made?.worktree?.path)
  assert.equal(made?.workspaceId, 'litch')
  await assert.rejects(
    channel.command('session.create', {
      deviceId: 'local',
      harness: 'claude',
      cwd: '/elsewhere',
      text: 'x',
      worktree: {},
    }),
    { code: 'rejected' },
  )
})

test('WT-CORE-005 模拟：父会话在工作树里时派的子会话默认开新的（从父会话的分支切），明说不要的共用；提案投影带开关的初值', async () => {
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
  time.advance(50)
  await settle()
  const spawn = (extra: object) =>
    channel.command('session.spawn', {
      deviceId: 'local',
      parentId: 's4',
      kind: 'fresh',
      title: 'Split the sidebar',
      prompt: 'Split the sidebar into two files',
      wakeParent: true,
      ...extra,
    })
  const { sessionId: own } = await spawn({})
  const { sessionId: shared } = await spawn({ worktree: false })
  for (let i = 0; i < 20 && !rows.get(own)?.worktree; i++) {
    time.advance(50)
    await settle()
  }
  assert.equal(rows.get(own)?.worktree?.baseRef, 'litch/sidebar-tweaks-3f2a1c')
  assert.equal(rows.get(own)?.cwd, rows.get(own)?.worktree?.path)
  assert.equal(rows.get(shared)?.worktree, null)
  assert.equal(rows.get(shared)?.cwd, rows.get('s4')?.cwd)
  // 提案投影：模型定的、没定时的缺省
  const [view] = projectProposals(
    [
      {
        id: 'p1',
        threadId: 's4',
        title: 't',
        prompt: 'p',
        harness: null,
        model: null,
        cwd: null,
        kind: 'fresh',
        wakeParent: true,
        status: 'pending',
        createdAt: 1,
        expiresAt: 2_000_000_000,
        startedThreadId: null,
        worktree: null,
        worktreeDefault: true,
      },
    ],
    1_700_000_000_000,
  )
  assert.deepEqual([view?.worktree, view?.worktreeDefault], [null, true])
})
