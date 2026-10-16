// 设备服务是哪一份、换没换版本：核心从聚合面读对面报的来历（协议扩展 deviceService），
// 本机另外从外壳那里拿这次连接换版本的结果。对着假的聚合面（fake-device.mts）跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AppOp,
  type AppView,
  createCore,
  type DeviceStore,
  type DeviceView,
  projectService,
  projectUpgrade,
  type RemotePlatform,
  type ServiceUpgradeReport,
} from '../src/index.mjs'
import { type FakeDevice, fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { runtimeInfo } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

/** 设备服务报的来历，照协议里的形状 */
const FACTS = {
  pid: 4821,
  version: '0.7.0',
  root: '/Applications/Litch.app/Contents/Resources/adapter',
  startedAt: '2026-10-13T08:30:00Z',
  detached: true,
  build: '1760000000000000000-9437184',
}

/** 外壳记的那一份换版本结果。fields 盖掉其中几项 */
const report = (fields: Partial<ServiceUpgradeReport> = {}): ServiceUpgradeReport => ({
  action: 'kept',
  running: { version: '0.6.0' },
  bundled: { version: '0.7.0', root: FACTS.root },
  order: 'older',
  reason: null,
  busy: [],
  detail: null,
  pid: 4821,
  ...fields,
})

interface WorldOptions {
  /** 连上之前先改一改假设备（声明的扩展、报的来历） */
  prepare?(device: FakeDevice): void
  /** 外壳给本机的换版本结果。不给就是没有这回事 */
  upgrade?: () => ServiceUpgradeReport | null
  /** 不用假的聚合面，换成这张方法表：单个 harness 的入口、原生 codex */
  handlers?: Record<string, Handler>
}

/** 一个真的核心，本机对面是假的聚合面。设备的显示数据像界面那样把快照和增量落下来 */
function world(options: WorldOptions = {}) {
  const fake = fakeDevice([
    harness('pi', { displayName: 'Pi', threads: [thread({ id: 'p1', updatedAt: 1_700_000_400 })] }),
  ])
  options.prepare?.(fake.device)
  const time = fakeClock()
  const peer = fakeOpener(options.handlers ?? fake.handlers)
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
        ...(options.upgrade ? { upgrade: options.upgrade } : {}),
      },
    ],
  })
  const app = { first: null as AppView | null, ops: [] as AppOp[] }
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        app.first = data as AppView
      },
      delta: (ops) => app.ops.push(...(ops as AppOp[])),
      error() {},
    },
  )
  const device = (): DeviceView => {
    const last = app.ops.findLast((op) => op.op === 'device.upsert')
    const view = last?.op === 'device.upsert' ? last.device : app.first?.devices[0]
    if (!view) throw new Error('还没有设备的显示数据')
    return view
  }
  /** 对面收到过几次 runtime/info */
  const asked = () =>
    peer.servers.flatMap((server) => server.seen.filter((entry) => entry.method === 'runtime/info'))
      .length
  return { core, fake: fake.device, peer, time, app, device, asked }
}

test('握手时声明认识 deviceService；聚合面报了来历，设备的显示数据里就有', async () => {
  const w = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
      device.service = FACTS
    },
  })
  assert.equal(w.device().service, null, '还没连上过：不知道')
  w.core.start()
  await settle()
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(init.capabilities.litchExtensions.includes('deviceService'))
  // 启动时间换成了毫秒；程序文件的戳界面用不着，不带过来
  assert.deepEqual(w.device().service, {
    version: '0.7.0',
    root: FACTS.root,
    startedAt: Date.parse('2026-10-13T08:30:00Z'),
    detached: true,
    pid: 4821,
  })
  assert.equal(w.device().upgrade, null, '外壳没给换版本的结果：没有这回事')
  assert.equal(w.asked(), 1, '来历已经有了，不再问')
  assert.equal(w.time.pending(), 0)
})

test('不报来历的旧版设备服务：没有这一项，别的照常，也不去补问', async () => {
  const w = world()
  w.core.start()
  await settle()
  assert.equal(w.device().mode, 'full')
  assert.equal(w.device().connection, 'online')
  assert.equal(w.device().service, null)
  w.time.advance(60_000)
  await settle()
  assert.equal(w.asked(), 1)
})

test('对面报的来历不成样子：整个不要；只有启动时间读不懂时，别的照给', () => {
  assert.equal(projectService(undefined), null)
  assert.equal(projectService('0.7.0'), null)
  assert.equal(projectService([FACTS]), null)
  for (const broken of [
    { ...FACTS, pid: '4821' },
    { ...FACTS, pid: 1.5 },
    { ...FACTS, version: '' },
    { ...FACTS, version: 7 },
    { ...FACTS, root: null },
    { ...FACTS, detached: 'yes' },
  ]) {
    assert.equal(projectService(broken), null, JSON.stringify(broken))
  }
  assert.equal(projectService({ ...FACTS, startedAt: '昨天' })?.startedAt, null)
  assert.equal(projectService({ ...FACTS, startedAt: 1760000000 })?.startedAt, null)
  assert.equal(projectService({ ...FACTS, startedAt: '昨天' })?.version, '0.7.0')
})

test('单个 harness 的入口和原生 codex：对面没有这一项，照常工作', async () => {
  const threads = () => ({
    data: [thread({ id: 'a', turns: [] })],
    nextCursor: null,
    backwardsCursor: null,
  })
  // 适配器某个 harness 自己的入口：runtime/info 是单个运行时的形状
  const entry = world({
    handlers: { 'runtime/info': () => runtimeInfo(), 'thread/list': threads },
    upgrade: () => null,
  })
  entry.core.start()
  await settle()
  assert.equal(entry.device().mode, 'single')
  assert.equal(entry.device().connection, 'online')
  assert.equal(entry.device().service, null)
  assert.equal(entry.device().upgrade, null)

  // 原生 codex：连 runtime/info 都不认识
  const codex = world({ handlers: { 'thread/list': threads } })
  codex.core.start()
  await settle()
  assert.equal(codex.device().mode, 'single')
  assert.equal(codex.device().connection, 'online')
  assert.equal(codex.device().service, null)
  assert.deepEqual(
    codex.device().harnesses.map((item) => item.state),
    ['ready'],
  )
})

test('设备服务说了会报、这一次却没给（设备进程刚起来）：过一会儿再问，问到了补上', async () => {
  const w = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
    },
  })
  w.core.start()
  await settle()
  assert.equal(w.device().connection, 'online')
  assert.equal(w.device().service, null)
  assert.equal(w.asked(), 1)

  // 头一次补问还是没有
  w.time.advance(1000)
  await settle()
  assert.equal(w.asked(), 2)
  assert.equal(w.device().service, null)

  // 主进程的状态送到了设备进程：下一次补问就有了，之后不再问
  w.fake.service = FACTS
  w.time.advance(2000)
  await settle()
  assert.equal(w.asked(), 3)
  assert.equal(w.device().service?.version, '0.7.0')
  w.time.advance(60_000)
  await settle()
  assert.equal(w.asked(), 3)
})

test('补问有个头：问了几次都没有就算了；连接断了，那一趟作废', async () => {
  const w = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
    },
  })
  w.core.start()
  await settle()
  for (let round = 0; round < 8; round++) {
    w.time.advance(5000)
    await settle()
  }
  assert.equal(w.asked(), 5, '连上时一次，之后补问四次')
  assert.equal(w.time.pending(), 0)

  // 断线：等着的补问取消；连回来之后从头算
  const dropped = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
    },
  })
  dropped.core.start()
  await settle()
  assert.equal(dropped.time.pending(), 1, '等着补问')
  dropped.peer.last().drop()
  await settle()
  dropped.fake.service = FACTS
  dropped.time.advance(500)
  await settle()
  assert.equal(dropped.device().connection, 'online')
  assert.equal(dropped.device().service?.pid, 4821, '连回来时对面已经报了')
  assert.equal(dropped.asked(), 2, '每条连接各问一次，作废的那一趟没有再问')
})

test('本机：外壳给的换版本结果每次连上之后取一次；重新连接之后是新的那一份', async () => {
  const busy = [
    { reason: 'activeTurns', harnesses: ['pi'], count: 0 },
    { reason: 'clients', harnesses: [], count: 2 },
  ]
  let current: ServiceUpgradeReport | null = report({ reason: 'busy', busy })
  let taken = 0
  const w = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
      device.service = { ...FACTS, version: '0.6.0' }
    },
    upgrade() {
      taken++
      return current
    },
  })
  assert.equal(taken, 0, '没连上之前不取')
  w.core.start()
  await settle()
  assert.equal(taken, 1)
  assert.deepEqual(w.device().upgrade, {
    action: 'kept',
    bundled: { version: '0.7.0', root: FACTS.root },
    previous: '0.6.0',
    order: 'older',
    reason: 'busy',
    busy,
    detail: null,
    pid: 4821,
  })
  assert.equal(w.device().service?.version, '0.6.0')

  // “现在再试一次”：连着的时候重新连一次。这一回它闲着，外壳把它换掉了
  current = report({ action: 'replaced', pid: 4907 })
  w.fake.service = { ...FACTS, pid: 4907 }
  await w.core.command('device.reconnect', { deviceId: 'local' }, never)
  await settle()
  assert.equal(taken, 2)
  assert.equal(w.peer.servers.length, 2, '丢掉原来那条连接，另连了一条')
  assert.equal(w.device().connection, 'online')
  assert.deepEqual(
    [w.device().upgrade?.action, w.device().upgrade?.previous, w.device().upgrade?.reason],
    ['replaced', '0.6.0', null],
  )
  assert.equal(w.device().service?.version, '0.7.0')
  assert.equal(w.device().service?.pid, 4907)
})

test('断开之后留着断开前知道的；连回来再认一遍', async () => {
  const w = world({
    prepare(device) {
      device.extensions = ['harness', 'deviceService']
      device.service = FACTS
    },
    upgrade: () => report({ action: 'launched', running: { version: '0.7.0' }, order: 'same' }),
  })
  w.core.start()
  await settle()
  w.peer.last().drop()
  await settle()
  assert.notEqual(w.device().connection, 'online')
  assert.equal(w.device().service?.version, '0.7.0')
  assert.equal(w.device().upgrade?.action, 'launched')

  // 连回来时对面换了一份
  w.fake.service = { ...FACTS, version: '0.8.0', detached: false }
  w.time.advance(500)
  await settle()
  assert.equal(w.device().connection, 'online')
  assert.deepEqual([w.device().service?.version, w.device().service?.detached], ['0.8.0', false])
})

test('换版本的结果只带界面用得着的：没换的原因、忙的明细、命令行的原话、进程号', () => {
  assert.equal(projectUpgrade(null), null)
  assert.equal(projectUpgrade(undefined), null)
  // 这次刚拉起的：之前没有服务，不留“之前的版本”
  assert.deepEqual(
    projectUpgrade(report({ action: 'launched', running: { version: '0.7.0' }, order: 'same' })),
    {
      action: 'launched',
      bundled: { version: '0.7.0', root: FACTS.root },
      previous: null,
      order: 'same',
      reason: null,
      busy: [],
      detail: null,
      pid: 4821,
    },
  )
  // 没报来历的旧服务，不认识停止的请求：版本不知道，原话和进程号带着
  const unsupported = projectUpgrade(
    report({ running: null, order: 'unknown', reason: 'unsupported', detail: '停不了它', pid: 77 }),
  )
  assert.deepEqual(
    [unsupported?.previous, unsupported?.reason, unsupported?.detail, unsupported?.pid],
    [null, 'unsupported', '停不了它', 77],
  )
  // 外壳那一份里多出来的东西（启动参数、程序文件的戳）不带过去；忙的明细只在因为忙没换时带
  const given = {
    ...report({ reason: 'foreground', busy: [{ reason: 'clients', harnesses: [], count: 1 }] }),
    running: { version: '0.6.0', pid: 1, root: '/x', build: 'b1', options: ['--ssh=on'] },
    bundled: { version: '0.7.0', root: FACTS.root, build: 'b2' },
  }
  const view = projectUpgrade(given)
  assert.deepEqual(view?.busy, [])
  assert.deepEqual(view?.bundled, { version: '0.7.0', root: FACTS.root })
  assert.ok(!JSON.stringify(view).includes('--ssh=on'))
  // 交出去的是另一份：外壳之后再动它自己的，不影响已经给界面的
  const list = [{ reason: 'activeTurns', harnesses: ['pi'], count: 0 }]
  const kept = projectUpgrade(report({ reason: 'busy', busy: list }))
  list[0]?.harnesses.push('claude')
  assert.deepEqual(kept?.busy, [{ reason: 'activeTurns', harnesses: ['pi'], count: 0 }])
})

test('远程设备：经 ssh 接的设备服务同样读得到是哪一份；换版本不是这边的事', async () => {
  const fake = fakeDevice([harness('pi', { threads: [thread({ id: 'r1' })] })])
  fake.device.extensions = ['harness', 'deviceService']
  fake.device.service = {
    ...FACTS,
    root: '/home/dev/.local/share/codex-harness-adapter/0.7.0/libexec',
    detached: false,
  }
  const far = fakeOpener(fake.handlers)
  const remote: RemotePlatform = {
    opener: () => far.open,
    discover: async () => [],
    check: async () => ({
      ok: true,
      peer: 'service',
      version: '0.7.0',
      system: 'Linux',
      running: true,
      harnesses: null,
    }),
  }
  const store: DeviceStore = {
    load: () => ({
      localWire: null,
      remotes: [
        {
          id: 'ssh-1',
          name: 'build-01',
          target: { kind: 'alias', alias: 'build-01' },
          wire: 'orange',
        },
      ],
    }),
    save() {},
    snapshot: () => ({ load: () => null, save() {} }),
    forget() {},
  }
  const time = fakeClock()
  const core = createCore({ clock: time.clock, version: '9.9.9', remote, store, devices: [] })
  const views = new Map<string, DeviceView>()
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        for (const view of (data as AppView).devices) views.set(view.id, view)
      },
      delta(ops) {
        for (const op of ops as AppOp[]) {
          if (op.op === 'device.upsert') views.set(op.device.id, op.device)
        }
      },
      error() {},
    },
  )
  core.start()
  await settle()
  const view = views.get('ssh-1')
  assert.equal(view?.kind, 'ssh')
  assert.equal(view?.connection, 'online')
  assert.deepEqual(
    [view?.service?.version, view?.service?.root, view?.service?.detached],
    ['0.7.0', '/home/dev/.local/share/codex-harness-adapter/0.7.0/libexec', false],
  )
  assert.equal(view?.upgrade, null)
})
