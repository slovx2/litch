import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Manager, ManagerBoard } from '../../protocol/src/manager.mjs'
import { MANAGER_METHOD, MANAGER_NOTIFICATION } from '../../protocol/src/manager.mjs'
import { createManagers, type ManagersHost } from '../src/device/manager.mjs'
import {
  ChannelError,
  connectChannel,
  createCore,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type ManagerBoardTopicView,
  type ManagersView,
  type ManagerView,
  managerBoardPages,
  managerMark,
  managerSessionIds,
  projectManager,
  projectManagerAnswers,
  projectManagerBoard,
  type SessionChildren,
  type SessionSummary,
  serveChannel,
} from '../src/index.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

function sample() {
  const data = sampleManagers('local', 1_800_000_000, 'zh-CN')
  const manager = data.managers[0]
  const board = data.boards[0]
  assert.ok(manager && board)
  return { manager: manager as Manager, board: board as ManagerBoard }
}

test('投影递归转换时间点，保留时长与审计原文，并提供四页分组', () => {
  const { manager, board } = sample()
  board.changes.push({
    id: 'c',
    objectId: 'manager',
    by: 'user',
    at: 12,
    fields: ['updatedAt'],
    before: { updatedAt: 10 },
    after: { updatedAt: 12 },
    why: '',
  })
  const decision = board.decisions[3]
  assert.ok(decision)
  const projected = projectManagerBoard('dev', board)
  assert.equal(projected.decisions[0]?.createdAt, (board.decisions[0]?.createdAt ?? 0) * 1000)
  assert.equal(projected.decisions[3]?.answer?.at, (decision.answer?.at ?? 0) * 1000)
  assert.equal(projected.lines[0]?.report?.at, (board.lines[0]?.report?.at ?? 0) * 1000)
  assert.equal(projected.lines[0]?.elapsedSeconds, board.lines[0]?.elapsedSeconds)
  assert.equal(projected.changes[0]?.at, 12000)
  assert.deepEqual(projected.changes[0]?.after, { updatedAt: 12 })
  assert.equal(projectManager('dev', manager).createdAt, manager.createdAt * 1000)
  const result = projectManagerAnswers({
    accepted: [decision],
    rejected: [{ decisionId: decision.id, code: 'decisionConflict', message: '', decision }],
    delivery: 'queued',
  })
  assert.equal(result.rejected[0]?.decision?.answer?.at, projected.decisions[3]?.answer?.at)
  const pages = managerBoardPages(projected)
  assert.deepEqual(
    [
      pages.decisions.pending.length,
      pages.decisions.answered.length,
      pages.decisions.closed.length,
    ],
    [3, 2, 1],
  )
  assert.deepEqual(
    [
      pages.overview.blocked.length,
      pages.overview.waitingForYou.length,
      pages.items.done.length,
      pages.lines.length,
    ],
    [2, 2, 3, 4],
  )
})

test('副本：普通侧栏过滤整棵经理树，经理复用原有 children 和 summary，看板引用计数', async () => {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  const server = serveChannel(corePort, createMockCore({ clock: time.clock }), {
    clock: time.clock,
  })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  const stop = replica.start()
  await settle()
  await settle()
  assert.equal(replica.store.get(keys.managersPending), 4)
  assert.deepEqual(replica.store.get(keys.managerIds('local')), ['m1', 'm3', 'e1', 'e2'])
  const root = replica.store.get<SessionSummary>(keys.summary('local', 'm1'))
  assert.ok(root)
  assert.equal(managerMark(root)?.role, 'manager')
  assert.deepEqual(replica.store.get<SessionChildren>(keys.children('local'))?.m1, [
    'manager-k1',
    'manager-k2',
    'manager-k3',
    'manager-k4',
  ])
  const groups = JSON.stringify(replica.store.get(keys.groups('local')))
  assert.ok(!groups.includes('"m1"') && !groups.includes('"manager-k1"'))
  assert.ok(groups.includes('"k1"'), '原有普通会话不与经理子会话重名')
  const descendant = {
    ...root,
    id: 'grandchild',
    litchManager: undefined,
    lineage: {
      parentId: 'manager-k1',
      kind: 'fresh',
      origin: 'model',
      title: '',
      wakeParent: true,
      createdAt: 0,
      proposalId: null,
    },
  } as SessionSummary
  const child = replica.store.get<SessionSummary>(keys.summary('local', 'manager-k1'))
  assert.ok(child)
  assert.ok(managerSessionIds([descendant, child, root]).has('grandchild'))
  const close1 = replica.openManagerBoard('local', 'm1')
  const close2 = replica.openManagerBoard('local', 'm1')
  await settle()
  assert.equal(
    replica.store.get<ManagerBoardTopicView>(keys.managerBoard('local', 'm1'))?.board?.items.length,
    9,
  )
  close1()
  close1()
  assert.ok(replica.store.get(keys.managerBoard('local', 'm1')))
  close2()
  assert.equal(replica.store.get(keys.managerBoard('local', 'm1')), undefined)
  stop()
  assert.equal(replica.store.get(keys.managerIds('local')), undefined)
  channel.close()
  server()
})

function serviceWorld(handlers: Record<string, Handler>) {
  let online = true
  let supported = true
  const calls: string[] = []
  const host: ManagersHost = {
    deviceId: 'local',
    online: () => online,
    supported: () => supported,
    request: (async (method: string, params: unknown) => {
      calls.push(method)
      return handlers[method]?.(params)
    }) as ManagersHost['request'],
    fail: (error) =>
      error instanceof ChannelError ? error : new ChannelError('internal', String(error)),
    changed() {},
    log() {},
  }
  const service = createManagers(host)
  const lists: ManagersView[] = []
  const boards: ManagerBoardTopicView[] = []
  service.open({
    snapshot: (data) => lists.push(data as ManagersView),
    delta: (ops) => {
      const manager = (ops[0] as { manager: ManagerView }).manager
      lists.push({ deviceId: 'local', available: true, managers: [manager] })
    },
    error() {},
  })
  service.openBoard('m1', {
    snapshot: (data) => boards.push(data as ManagerBoardTopicView),
    delta: (ops) => boards.push((ops[0] as { view: ManagerBoardTopicView }).view),
    error() {},
  })
  return {
    service,
    lists,
    boards,
    calls,
    offline() {
      online = false
      service.offline()
    },
    connect(value = true) {
      online = true
      supported = value
      service.resync()
    },
  }
}

test('列表对账不覆盖在途通知，看板失效合并补读，断线废弃结果并保留快照', async () => {
  const { manager, board } = sample()
  let resolveList: (value: unknown) => void = () => {}
  let resolveBoard: (value: unknown) => void = () => {}
  let delayBoard = false
  const w = serviceWorld({
    [MANAGER_METHOD.list]: () =>
      new Promise((resolve) => {
        resolveList = resolve
      }),
    [MANAGER_METHOD.boardRead]: () =>
      delayBoard
        ? new Promise((resolve) => {
            resolveBoard = resolve
          })
        : { board },
  })
  await settle()
  w.connect()
  w.service.notification(MANAGER_NOTIFICATION.changed, {
    manager: { ...manager, name: '更新名字', updatedAt: manager.updatedAt + 10 },
  })
  resolveList({ managers: [manager] })
  await settle()
  assert.equal(w.lists.at(-1)?.managers[0]?.name, '更新名字')
  delayBoard = true
  w.service.notification(MANAGER_NOTIFICATION.boardChanged, { managerId: 'm1' })
  w.service.notification(MANAGER_NOTIFICATION.boardChanged, { managerId: 'm1' })
  const count = w.boards.length
  delayBoard = false
  resolveBoard({ board: { ...board, items: [] } })
  await settle()
  assert.equal(w.boards.length, count + 1)
  assert.equal(w.boards.at(-1)?.board?.items.length, 9)
  delayBoard = true
  w.service.notification(MANAGER_NOTIFICATION.boardChanged, { managerId: 'm1' })
  w.offline()
  resolveBoard({ board: { ...board, items: [] } })
  await settle()
  assert.equal(w.boards.at(-1)?.board?.items.length, 9)
  const calls = w.calls.length
  w.connect(false)
  assert.equal(w.calls.length, calls)
  assert.equal(w.lists.at(-1)?.available, false)
  assert.equal(w.boards.at(-1)?.board, null)
  await assert.rejects(w.service.end('m1'), { code: 'unsupported' })
})

for (const supported of [true, false])
  test(`真实核心握手与设备扩展门控：${supported}`, async () => {
    const { manager, board } = sample()
    const fake = fakeDevice([
      harness('claude', {
        threads: [
          Object.assign(thread({ id: 'm1' }), {
            litchManager: { managerId: 'm1', role: 'manager' },
          }),
        ],
      }),
    ])
    fake.device.extensions = supported ? ['harness', 'litchManager'] : ['harness']
    const peer = fakeOpener({
      ...fake.handlers,
      [MANAGER_METHOD.list]: () => ({ managers: [manager] }),
      [MANAGER_METHOD.boardRead]: () => ({ board }),
      [MANAGER_METHOD.update]: (params) => ({ manager: { ...manager, ...(params as object) } }),
    })
    const time = fakeClock()
    const core = createCore({
      clock: time.clock,
      version: '1.0.0',
      log() {},
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
    core.start()
    const snapshots: ManagersView[] = []
    core.subscribe(
      { kind: 'managers', deviceId: 'local' },
      { snapshot: (data) => snapshots.push(data as ManagersView), delta() {}, error() {} },
    )
    core.subscribe(
      { kind: 'managerBoard', deviceId: 'local', managerId: 'm1' },
      { snapshot() {}, delta() {}, error() {} },
    )
    await settle()
    await settle()
    const seen = peer.last().seen
    const init = seen.find((entry) => entry.method === 'initialize')?.params as {
      capabilities: { litchExtensions: string[] }
    }
    assert.ok(init.capabilities.litchExtensions.includes('litchManager'))
    assert.equal(snapshots.at(-1)?.available, supported)
    assert.equal(
      seen.some((entry) => entry.method === MANAGER_METHOD.list),
      supported,
    )
    assert.equal(
      seen.some((entry) => entry.method === MANAGER_METHOD.boardRead),
      supported,
    )
    const request = core.command(
      'managers.update',
      { deviceId: 'local', managerId: 'm1', patch: { name: '改名' } },
      { aborted: false, addEventListener() {} },
    )
    if (supported) assert.equal(((await request) as { manager: ManagerView }).manager.name, '改名')
    else await assert.rejects(request, { code: 'unsupported' })
    core.stop()
  })

test('模拟核心通道：提交答复增加对话回合，结束的示例经理只读', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  const [uiPort, corePort] = createPortPair()
  const close = serveChannel(corePort, core, { clock: time.clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  const stop = replica.start()
  await settle()
  await settle()
  replica.openSession('local', 'm1')
  replica.openSession('local', 'e1')
  replica.openManagerBoard('local', 'm1')
  await settle()
  const before = replica.store.get<string[]>(keys.turnIds('local', 'm1'))?.length ?? 0
  const result = await channel.command('managers.answers.submit', {
    deviceId: 'local',
    managerId: 'm1',
    answers: [{ decisionId: 'D-17', revision: 1, optionId: null, text: '请在网关降级处理' }],
  })
  assert.equal(result.accepted.length, 1)
  time.advance(20)
  await settle()
  assert.equal(replica.store.get<string[]>(keys.turnIds('local', 'm1'))?.length, before + 1)
  assert.equal(
    replica.store.get<ManagerBoardTopicView>(keys.managerBoard('local', 'm1'))?.board?.activities
      .length,
    7,
  )
  assert.equal(replica.store.get<ManagerView>(keys.manager('local', 'm1'))?.pendingDecisions, 2)
  await assert.rejects(
    channel.command('session.send', { deviceId: 'local', sessionId: 'e1', text: '不应发送' }),
    { code: 'rejected' },
  )
  stop()
  channel.close()
  close()
})

test('设备返回经理领域错误时保留错误码、字段和双语提示', async () => {
  const { RpcError } = await import('../src/connection/rpc.mjs')
  const w = serviceWorld({
    [MANAGER_METHOD.boardRead]: () => ({ board: sample().board }),
    [MANAGER_METHOD.update]: () => {
      throw new RpcError(-32602, 'Scope is required', { litch: 'invalidManager', field: 'scope' })
    },
    [MANAGER_METHOD.end]: () => {
      throw new RpcError(-32600, 'The manager has ended', { litch: 'managerEnded' })
    },
  })
  await assert.rejects(w.service.update('m1', { scope: '' }), { code: 'invalid', key: 'scope' })
  await assert.rejects(w.service.end('m1'), {
    code: 'rejected',
    said: { 'zh-CN': '经理已结束，看板只读', en: 'The manager has ended' },
  })
})
