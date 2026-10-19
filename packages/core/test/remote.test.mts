// 远程设备：连接配置的检查、连接途中报告走到哪一步、设备的增改删与落盘、离线时的侧栏快照。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AppOp,
  type AppView,
  ConnectError,
  checkSaved,
  checkTarget,
  createCore,
  createLink,
  type DeviceSnapshot,
  type DeviceStore,
  type DeviceView,
  type LinkState,
  phrase,
  type RemotePlatform,
  type RemoteTarget,
  type SavedDevices,
  type SidebarView,
  type TransportOpener,
} from '../src/index.mjs'
import { fakeOpener } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const alias = (name: string): RemoteTarget => ({ kind: 'alias', alias: name })

test('连接配置：别名和手动填的主机都认；会被 ssh 当成选项的、带空白的一律拒绝', () => {
  assert.deepEqual(checkTarget({ kind: 'alias', alias: ' build-01 ' }), alias('build-01'))
  assert.deepEqual(checkTarget({ kind: 'host', host: 'nas.lan', port: '2222', user: 'admin' }), {
    kind: 'host',
    host: 'nas.lan',
    port: 2222,
    user: 'admin',
    keyFile: null,
  })
  assert.deepEqual(
    checkTarget({ kind: 'host', host: '10.0.0.2', keyFile: '~/.ssh/my key' }),
    { kind: 'host', host: '10.0.0.2', port: null, user: null, keyFile: '~/.ssh/my key' },
    '密钥文件的路径里可以有空格',
  )
  const bad: unknown[] = [
    null,
    { kind: 'alias', alias: '' },
    { kind: 'alias', alias: '-oProxyCommand=evil' },
    { kind: 'alias', alias: 'a b' },
    { kind: 'alias', alias: 'a\nb' },
    { kind: 'host', host: 'dev@nas' },
    { kind: 'host', host: 'nas', port: 70000 },
    { kind: 'host', host: 'nas', port: 'abc' },
    { kind: 'host', host: 'nas', user: '-l root' },
    { kind: 'host', host: 'nas', keyFile: '-oProxyCommand=evil' },
    { kind: 'socket', path: '/tmp/x' },
  ]
  for (const value of bad) {
    assert.throws(() => checkTarget(value), { code: 'rejected' }, JSON.stringify(value))
  }
})

test('存下来的设备配置：读不懂的那一条丢掉，其余照用', () => {
  const saved = checkSaved({
    localWire: 'violet',
    remotes: [
      { id: 'ssh-1', name: 'a', target: alias('a'), wire: 'blue' },
      { id: 'local', name: '冒充本机', target: alias('x'), wire: 'blue' },
      { id: 'ssh-2', name: '', target: { kind: 'alias', alias: '-bad' }, wire: 'blue' },
      { id: 'ssh-3', name: '', target: alias('c'), wire: 'pink' },
      'garbage',
    ],
  })
  assert.equal(saved.localWire, 'violet')
  assert.deepEqual(
    saved.remotes.map((remote) => [remote.id, remote.name, remote.wire]),
    [
      ['ssh-1', 'a', 'blue'],
      ['ssh-3', 'c', 'orange'],
    ],
  )
  assert.deepEqual(checkSaved(null), { localWire: null, remotes: [] })
})

test('连接：开传输的一方报了走到哪一步，状态里带着；失败的详情一路带到状态里', async () => {
  const time = fakeClock()
  const peer = fakeOpener({})
  let attempt = 0
  const open: TransportOpener = async (signal, report) => {
    attempt++
    report?.(phrase('ssh.step.connect'))
    await settle()
    if (attempt === 1) {
      report?.(phrase('ssh.step.probe'))
      throw new ConnectError(
        'notInstalled',
        phrase('remote.notInstalled'),
        false,
        'sh: codex: not found',
      )
    }
    return peer.open(signal)
  }
  const states: LinkState[] = []
  const link = createLink({
    open,
    clock: time.clock,
    clientInfo: { name: 'test', title: 'Test', version: '0' },
    state: (state) => states.push(state),
    notification() {},
  })
  link.start()
  await settle()
  await settle()
  const steps = states.flatMap((state) =>
    state.phase === 'connecting' && state.step && typeof state.step !== 'string'
      ? [state.step.key]
      : [],
  )
  assert.deepEqual(steps, ['ssh.step.connect', 'ssh.step.probe'])
  const failed = states[states.length - 1]
  assert.ok(failed?.phase === 'failed')
  assert.equal(failed.failure.stage, 'notInstalled')
  assert.equal(failed.failure.detail, 'sh: codex: not found')

  link.retry()
  await settle()
  await settle()
  assert.equal(states[states.length - 1]?.phase, 'connected')
})

/** 一个记在内存里的存储，和一个按别名给假对端的远程能力 */
function world(initial: Partial<SavedDevices> = {}) {
  let saved: SavedDevices = { localWire: null, remotes: [], ...initial }
  const snapshots = new Map<string, DeviceSnapshot>()
  const forgotten: string[] = []
  const store: DeviceStore = {
    load: () => saved,
    save(next) {
      saved = next
    },
    snapshot: (deviceId) => ({
      load: () => snapshots.get(deviceId) ?? null,
      save: (snapshot) => {
        snapshots.set(deviceId, snapshot)
      },
    }),
    forget(deviceId) {
      forgotten.push(deviceId)
      snapshots.delete(deviceId)
    },
  }
  const peers = new Map<string, ReturnType<typeof fakeOpener>>()
  /** 这个别名连过去会遇到什么错。没有就是连得上 */
  const broken = new Map<string, ConnectError>()
  const peerOf = (name: string) => {
    let peer = peers.get(name)
    if (!peer) {
      peer = fakeOpener({
        'thread/list': () => ({
          data: [thread({ id: `${name}-t1`, cwd: '/srv', preview: `在 ${name} 上` })],
          nextCursor: null,
          backwardsCursor: null,
        }),
      })
      peers.set(name, peer)
    }
    return peer
  }
  const nameOf = (target: RemoteTarget) => (target.kind === 'alias' ? target.alias : target.host)
  const remote: RemotePlatform = {
    opener: (target) => async (signal, report) => {
      report?.(phrase('ssh.step.connect'))
      const failure = broken.get(nameOf(target))
      if (failure) throw failure
      return peerOf(nameOf(target)).open(signal)
    },
    discover: async () => [{ alias: 'build-01', host: '10.0.0.1', user: 'dev', port: 22 }],
    check: async (target) =>
      broken.has(nameOf(target))
        ? {
            ok: false,
            failure: {
              stage: 'notInstalled',
              text: phrase('remote.notInstalled'),
              detail: null,
              retrying: false,
            },
          }
        : { ok: true, peer: 'codex', version: '0.160.0', system: 'Linux' },
  }
  const time = fakeClock()
  const local = fakeOpener({})
  const boot = () => {
    const core = createCore({
      clock: time.clock,
      version: '9.9.9',
      remote,
      store,
      devices: [
        {
          id: 'local',
          name: '本机',
          host: 'dev@mac',
          kind: 'local',
          target: null,
          wire: 'green',
          open: local.open,
        },
      ],
    })
    const app = { snapshot: null as AppView | null, ops: [] as AppOp[] }
    core.subscribe(
      { kind: 'app' },
      {
        snapshot: (data) => {
          app.snapshot = data as AppView
        },
        delta: (ops) => app.ops.push(...(ops as AppOp[])),
        error() {},
      },
    )
    /** 一台设备现在的样子 */
    const device = (deviceId: string): DeviceView | undefined => {
      const last = app.ops.findLast(
        (op) => (op.op === 'device.upsert' ? op.device.id : op.deviceId) === deviceId,
      )
      if (last) return last.op === 'device.upsert' ? last.device : undefined
      return app.snapshot?.devices.find((entry) => entry.id === deviceId)
    }
    const command = (name: string, params: unknown) =>
      core.command(name, params, new AbortController().signal)
    return { core, app, device, command }
  }
  return { boot, time, peers, broken, forgotten, snapshots, saved: () => saved, peerOf }
}

test('添加远程设备：出现在设备表里、开始连、连上后列出会话，配置落了盘', async () => {
  const { boot, saved } = world()
  const { core, device, command } = boot()
  core.start()
  await settle()

  const { deviceId } = (await command('device.add', { name: '', target: alias('build-01') })) as {
    deviceId: string
  }
  const added = device(deviceId)
  assert.equal(added?.kind, 'ssh')
  assert.equal(added?.name, 'build-01', '没起名字就用别名')
  assert.equal(added?.host, 'build-01')
  assert.notEqual(added?.wire, 'green', '线色挑一个本机没用的')
  await settle()
  await settle()
  assert.equal(device(deviceId)?.connection, 'online')
  assert.equal(device(deviceId)?.mode, 'single')

  const sidebar: SidebarView[] = []
  core.subscribe(
    { kind: 'sidebar', deviceId },
    { snapshot: (data) => sidebar.push(data as SidebarView), delta() {}, error() {} },
  )
  assert.deepEqual(
    sidebar[0]?.sessions.map((session) => session.id),
    ['build-01-t1'],
  )
  assert.deepEqual(saved().remotes, [
    { id: deviceId, name: 'build-01', target: alias('build-01'), wire: added?.wire },
  ])

  await assert.rejects(command('device.add', { name: '再来', target: alias('build-01') }), {
    code: 'rejected',
  })
  await assert.rejects(
    command('device.add', { name: '', target: { kind: 'alias', alias: '-x' } }),
    {
      code: 'rejected',
    },
  )
})

test('重新打开应用：存着的远程设备都在，各连各的', async () => {
  const { boot } = world({
    localWire: 'violet',
    remotes: [{ id: 'ssh-1', name: '构建机', target: alias('build-01'), wire: 'blue' }],
  })
  const { core, app, device } = boot()
  assert.deepEqual(
    app.snapshot?.devices.map((entry) => [entry.id, entry.name, entry.wire]),
    [
      ['local', '本机', 'violet'],
      ['ssh-1', '构建机', 'blue'],
    ],
  )
  core.start()
  await settle()
  await settle()
  assert.equal(device('ssh-1')?.connection, 'online')
  assert.equal(device('local')?.connection, 'online')
})

test('没连上：带着是哪一步、还会不会自己再试；手动重试能连上', async () => {
  const { boot, broken } = world()
  const { core, device, command } = boot()
  core.start()
  broken.set(
    'pi-lab',
    new ConnectError('notInstalled', phrase('remote.notInstalled'), false, 'not found'),
  )
  const { deviceId } = (await command('device.add', { name: '', target: alias('pi-lab') })) as {
    deviceId: string
  }
  await settle()
  await settle()
  const failed = device(deviceId)
  assert.equal(failed?.connection, 'error')
  assert.deepEqual(failed?.failure, {
    stage: 'notInstalled',
    text: phrase('remote.notInstalled'),
    detail: 'not found',
    retrying: false,
  })
  assert.equal(device('local')?.connection, 'online', '一台连不上不耽误别的')

  // 那台机器上装好了，点“重试”
  broken.delete('pi-lab')
  await command('device.reconnect', { deviceId })
  await settle()
  await settle()
  assert.equal(device(deviceId)?.connection, 'online')
  assert.equal(device(deviceId)?.failure, null)
})

test('没连上：该给哪一份“怎么办”一路带到设备上；连着的时候“重新连接”是真的再连一次', async () => {
  const { boot, broken, peerOf } = world()
  const { core, device, command } = boot()
  core.start()
  // 那台机器上有一份旧服务在跑：不重试，告诉人去重启它
  broken.set(
    'nas',
    new ConnectError(
      'outdated',
      phrase('remote.serviceLegacy'),
      false,
      '请先升级并重启它',
      'restartService',
    ),
  )
  const { deviceId } = (await command('device.add', { name: '', target: alias('nas') })) as {
    deviceId: string
  }
  await settle()
  await settle()
  assert.deepEqual(device(deviceId)?.failure, {
    stage: 'outdated',
    text: phrase('remote.serviceLegacy'),
    detail: '请先升级并重启它',
    guide: 'restartService',
    retrying: false,
  })

  broken.delete('nas')
  await command('device.reconnect', { deviceId })
  await settle()
  await settle()
  assert.equal(device(deviceId)?.connection, 'online')
  assert.equal(device(deviceId)?.failure, null)
  assert.equal(peerOf('nas').servers.length, 1)

  // 连着的时候再来一次（详情里的“重新检查”）：丢掉这条连接从头再连，对面是什么由开传输的一方现认
  await command('device.reconnect', { deviceId })
  await settle()
  await settle()
  assert.equal(peerOf('nas').servers.length, 2)
  assert.equal(device(deviceId)?.connection, 'online')
})

test('改设备：改名改色不动连接；换了一台机器就重新连、侧栏重来；本机只能改色', async () => {
  const { boot, saved, peers, forgotten } = world()
  const { core, device, command } = boot()
  core.start()
  const { deviceId } = (await command('device.add', { name: '', target: alias('build-01') })) as {
    deviceId: string
  }
  await settle()
  await settle()

  await command('device.update', { deviceId, name: ' 构建机 ', wire: 'red' })
  assert.equal(device(deviceId)?.name, '构建机')
  assert.equal(device(deviceId)?.wire, 'red')
  assert.equal(device(deviceId)?.connection, 'online', '连接没有断')
  assert.equal(peers.get('build-01')?.servers.length, 1)

  const sidebar: SidebarView[] = []
  core.subscribe(
    { kind: 'sidebar', deviceId },
    { snapshot: (data) => sidebar.push(data as SidebarView), delta() {}, error() {} },
  )
  await command('device.update', { deviceId, target: alias('build-02') })
  assert.deepEqual(forgotten, [deviceId], '换了机器，旧的快照不要了')
  assert.deepEqual(sidebar[sidebar.length - 1]?.sessions, [], '侧栏先清空')
  await settle()
  await settle()
  assert.equal(device(deviceId)?.connection, 'online')
  assert.equal(device(deviceId)?.host, 'build-02')
  assert.deepEqual(
    sidebar[sidebar.length - 1]?.sessions.map((session) => session.id),
    ['build-02-t1'],
  )
  assert.deepEqual(saved().remotes[0], {
    id: deviceId,
    name: '构建机',
    target: alias('build-02'),
    wire: 'red',
  })

  await command('device.update', { deviceId: 'local', wire: 'slate' })
  assert.equal(device('local')?.wire, 'slate')
  assert.equal(saved().localWire, 'slate')
  await assert.rejects(command('device.update', { deviceId: 'local', name: '改名' }), {
    code: 'rejected',
  })
})

test('移除设备：从设备表里拿掉、连接断开、配置和快照都清掉；本机移除不了', async () => {
  const { boot, saved, forgotten, peerOf } = world()
  const { core, app, device, command } = boot()
  core.start()
  const { deviceId } = (await command('device.add', { name: '', target: alias('build-01') })) as {
    deviceId: string
  }
  await settle()
  await settle()
  assert.equal(device(deviceId)?.connection, 'online')

  await command('device.remove', { deviceId })
  assert.deepEqual(app.ops[app.ops.length - 1], { op: 'device.remove', deviceId })
  assert.deepEqual(saved().remotes, [])
  assert.deepEqual(forgotten, [deviceId])
  assert.throws(() => core.subscribe({ kind: 'sidebar', deviceId }, {} as never), {
    code: 'notFound',
  })
  // 那台设备之后再有什么动静，都不该再冒出来
  const before = app.ops.length
  peerOf('build-01').last().drop()
  await settle()
  assert.equal(app.ops.length, before)

  await assert.rejects(command('device.remove', { deviceId: 'local' }), { code: 'rejected' })
})

test('离线时的侧栏：先摆上次留下的那份并标明是旧的；连上对过之后换成新的，再存一份', async () => {
  const { boot, snapshots, time } = world({
    remotes: [{ id: 'ssh-1', name: 'build-01', target: alias('build-01'), wire: 'blue' }],
  })
  snapshots.set('ssh-1', {
    mode: 'single',
    harnesses: [
      {
        id: 'codex',
        name: 'Codex',
        badge: 'CX',
        state: 'ready',
        version: '0.160.0',
        reason: null,
        detail: null,
        down: null,
        abilities: null,
      },
    ],
    workspaces: [],
    sections: [],
    threads: [
      thread({
        id: 'old',
        cwd: '/srv',
        preview: '上次的',
        status: { type: 'active', activeFlags: [] },
      }),
    ],
    unread: [],
  })
  const { core, device } = boot()
  const sidebar: SidebarView[] = []
  core.subscribe(
    { kind: 'sidebar', deviceId: 'ssh-1' },
    { snapshot: (data) => sidebar.push(data as SidebarView), delta() {}, error() {} },
  )
  assert.equal(device('ssh-1')?.stale, true)
  assert.deepEqual(
    sidebar[0]?.sessions.map((session) => [session.id, session.status]),
    [['old', 'idle']],
    '上次留下的会话摆出来；当时在跑的，现在不知道了，不显示成在跑',
  )
  assert.equal(device('ssh-1')?.harnesses[0]?.id, 'codex')

  core.start()
  await settle()
  await settle()
  assert.equal(device('ssh-1')?.stale, false)
  assert.deepEqual(
    sidebar[sidebar.length - 1]?.sessions.map((session) => session.id),
    ['build-01-t1'],
  )
  time.advance(2000)
  assert.deepEqual(
    snapshots.get('ssh-1')?.threads.map((entry) => entry.id),
    ['build-01-t1'],
  )
})
