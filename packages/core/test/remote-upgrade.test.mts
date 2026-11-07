// 远程设备服务的一键升级：什么时候算“比应用旧”、按钮做什么、装好之后怎么换上、不闲时怎么等。
// 真的核心对着假的聚合面（fake-device.mts），在那台机器上动手的那三件事换成按脚本应答的假能力；
// 时钟是假的，“每 5 分钟再请一次”靠拨表来验。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SWAP_RETRY_MS } from '../src/device/service-upgrade.mjs'
import {
  type AppOp,
  type AppView,
  ConnectError,
  createCore,
  type DeviceStore,
  type DeviceView,
  phrase,
  type RemoteInstallResult,
  type RemotePlatform,
  type RemoteStopResult,
  type RemoteUpgradePlatform,
  type RemoteUpgradeView,
} from '../src/index.mjs'
import { type FakeDevice, fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }
const APP = '0.16.0'
const SCRIPT_ROOT = (version: string) =>
  `/home/dev/.local/share/codex-harness-adapter/${version}/libexec`

/** 设备服务报的来历，照协议里的形状 */
const facts = (version: string, fields: Record<string, unknown> = {}) => ({
  pid: 1203,
  version,
  root: SCRIPT_ROOT(version),
  startedAt: '2026-10-20T08:30:00Z',
  detached: true,
  ...fields,
})

interface Calls {
  inspect: number
  install: { method: string; version: string }[]
  stop: boolean[]
}

interface WorldOptions {
  /** 连上之前先改一改假设备 */
  prepare?(device: FakeDevice): void
  /** 那台机器上装着的那一份 */
  installed?: { version: string | null; path: string | null }
  install?: () => RemoteInstallResult | Promise<RemoteInstallResult>
  /** 每次请停的应答，依次取；取完了就是“停了” */
  stops?: (RemoteStopResult | Error)[]
  /** 不给能力（手机端） */
  incapable?: boolean
  reconnectFailure?: boolean
  /** 连不上的原因：给了就一直连不上 */
  failure?: ConnectError
}

function world(options: WorldOptions = {}) {
  const fake = fakeDevice([harness('pi', { threads: [thread({ id: 'r1' })] })])
  fake.device.extensions = ['harness', 'deviceService']
  fake.device.service = facts('0.15.0')
  options.prepare?.(fake.device)
  const far = fakeOpener(fake.handlers)
  const calls: Calls = { inspect: 0, install: [], stop: [] }
  const stops = [...(options.stops ?? [])]
  /** 请停的那一下停了：假设备上的服务就换成 current 指的那一版（装好的新版） */
  let current = '0.15.0'
  const upgrade: RemoteUpgradePlatform = {
    async inspect() {
      calls.inspect++
      return options.installed ?? { version: current, path: null }
    },
    async install(_target, plan) {
      calls.install.push(plan)
      const result = await (options.install?.() ?? {
        ok: true as const,
        installed: plan.version,
        said: null,
      })
      if (result.ok) current = result.installed
      return result
    },
    async stop(_target, ifIdle) {
      calls.stop.push(ifIdle)
      const next = stops.shift() ?? { result: 'stopped' }
      if (next instanceof Error) throw next
      if (next.result === 'stopped') fake.device.service = facts(current)
      return next
    },
  }
  const remote: RemotePlatform = {
    opener: () => async (signal) => {
      if (options.failure) throw options.failure
      if (options.reconnectFailure && calls.stop.length > 0)
        throw new ConnectError('unreachable', phrase('ssh.unreachable'), true)
      return far.open(signal)
    },
    discover: async () => [],
    check: async () => ({
      ok: false,
      failure: { stage: 'unreachable', text: '', detail: null, retrying: false },
    }),
    ...(options.incapable ? {} : { upgrade }),
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
  const core = createCore({ clock: time.clock, version: APP, remote, store, devices: [] })
  let view: DeviceView | null = null
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        view = (data as AppView).devices.find((entry) => entry.id === 'ssh-1') ?? null
      },
      delta(ops) {
        for (const op of ops as AppOp[]) {
          if (op.op === 'device.upsert' && op.device.id === 'ssh-1') view = op.device
        }
      },
      error() {},
    },
  )
  const device = (): DeviceView => {
    if (!view) throw new Error('还没有设备的显示数据')
    return view
  }
  const upgradeView = (): RemoteUpgradeView | null => device().remoteUpgrade
  const run = (mode: 'start' | 'retry' | 'force' | 'cancel') =>
    core.command('device.upgradeService', { deviceId: 'ssh-1', mode }, never)
  return { core, fake: fake.device, far, time, calls, device, upgradeView, run }
}

/** 等几轮：假能力的应答、重连、对账都是异步的 */
const flush = async () => {
  for (let n = 0; n < 6; n++) await settle()
}

test('在跑的比应用旧：给出升级，装的是应用的这一版，装好闲着就换上，重连后是新版', async () => {
  const w = world({ installed: { version: '0.15.0', path: null } })
  w.core.start()
  await flush()
  assert.equal(w.device().connection, 'online')
  const before = w.upgradeView()
  assert.ok(before, '比应用旧：有这一项')
  assert.equal(before.running, '0.15.0')
  assert.equal(before.target, APP)
  assert.equal(before.method, 'script', '按服务的根目录认出是安装脚本装的')
  assert.equal(before.managed, false)
  assert.equal(before.action, 'upgrade')
  assert.equal(before.capable, true)
  assert.deepEqual(before.phase, { step: 'idle' })
  assert.equal(w.calls.inspect, 1, '问了一遍装着的版本')

  await w.run('start')
  await flush()
  assert.deepEqual(w.calls.install, [{ method: 'script', version: APP }])
  assert.deepEqual(w.calls.stop, [true], '装好了先请它空闲时停')
  assert.equal(w.far.servers.length, 2, '停了就重连了一次')
  const after = w.upgradeView()
  assert.deepEqual(after?.phase, { step: 'done', from: '0.15.0', to: APP })
  assert.equal(w.device().service?.version, APP)

  // 再连一次：已经不旧，“换上了”那句也不说了
  await w.core.command('device.reconnect', { deviceId: 'ssh-1' }, never)
  await flush()
  assert.equal(w.upgradeView(), null)
})

test('不闲：装好了等着换，每次连上、连着时每 5 分钟再请一次，闲了就换上', async () => {
  const busy = {
    result: 'busy' as const,
    busy: [{ reason: 'activeTurns', harnesses: ['pi'], count: 0 }],
  }
  const w = world({ stops: [busy, busy, busy] })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  assert.deepEqual(w.upgradeView()?.phase, { step: 'waiting', busy: busy.busy, checking: false })
  assert.equal(w.upgradeView()?.action, 'swap', '装着的已经是新版：只差换上')
  assert.equal(w.device().service?.version, '0.15.0', '留着旧的接着用')

  // 每次连上都再请一次
  await w.core.command('device.reconnect', { deviceId: 'ssh-1' }, never)
  await flush()
  assert.deepEqual(w.calls.stop, [true, true])
  assert.equal(w.upgradeView()?.phase.step, 'waiting')

  // 连着时 5 分钟之后再请一次
  w.time.advance(SWAP_RETRY_MS - 1)
  await flush()
  assert.equal(w.calls.stop.length, 2)
  w.time.advance(1)
  await flush()
  assert.deepEqual(w.calls.stop, [true, true, true])

  // 这一次闲了：停了、重连、是新版
  w.time.advance(SWAP_RETRY_MS)
  await flush()
  assert.deepEqual(w.calls.stop, [true, true, true, true])
  assert.deepEqual(w.upgradeView()?.phase, { step: 'done', from: '0.15.0', to: APP })
  w.time.advance(SWAP_RETRY_MS * 3)
  await flush()
  assert.equal(w.calls.stop.length, 4, '换上了：不再等')
})

test('远程未安装新版不能强制；取消等待后不再停止服务', async () => {
  const busy = { result: 'busy' as const, busy: [{ reason: 'clients', harnesses: [], count: 2 }] }
  const w = world({ stops: [busy] })
  w.core.start()
  await flush()
  await assert.rejects(w.run('force'), /新版已安装/)
  await w.run('start')
  await flush()
  assert.equal(w.upgradeView()?.phase.step, 'waiting')
  await w.run('cancel')
  w.time.advance(SWAP_RETRY_MS * 2)
  await flush()
  assert.deepEqual(w.calls.stop, [true])
  assert.equal(w.upgradeView()?.phase.step, 'idle')
})

test('远程等待中和已安装新版本的空闲状态都能明确强制换上', async () => {
  for (const cancel of [false, true]) {
    const w = world({
      stops: [
        { result: 'busy', busy: [{ reason: 'backgroundTasks', harnesses: ['codex'], count: 2 }] },
      ],
    })
    w.core.start()
    await flush()
    await w.run('start')
    await flush()
    if (cancel) await w.run('cancel')
    await w.run('force')
    await flush()
    assert.deepEqual(w.calls.stop, [true, false])
    assert.equal(w.calls.install.length, 1)
    assert.equal(w.upgradeView()?.phase.step, 'done')
    w.time.advance(SWAP_RETRY_MS * 2)
    await flush()
    assert.deepEqual(w.calls.stop, [true, false])
    w.core.stop()
  }
})

test('远程强制换上仍拒绝无能力、受托管及离线服务', async () => {
  for (const options of [
    { incapable: true },
    {
      prepare: (device: FakeDevice) => {
        device.service = facts('0.15.0', { detached: false })
      },
    },
    { failure: new ConnectError('unreachable', phrase('ssh.unreachable'), true) },
  ]) {
    const w = world({ ...options, installed: { version: APP, path: SCRIPT_ROOT(APP) } })
    w.core.start()
    await flush()
    await assert.rejects(w.run('force'))
    assert.deepEqual(w.calls.stop, [])
    w.core.stop()
  }
})

test('现在再试一次：等空闲时马上再请一次，还忙就接着等', async () => {
  const busy = {
    result: 'busy' as const,
    busy: [{ reason: 'deviceProcesses', harnesses: [], count: 1 }],
  }
  const w = world({ stops: [busy, busy] })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  await w.run('retry')
  await flush()
  assert.deepEqual(w.calls.stop, [true, true])
  assert.equal(w.upgradeView()?.phase.step, 'waiting')
})

test('装着的已经不旧（用户自己装过）：按钮是“换上新版”，不再装', async () => {
  const w = world({ installed: { version: APP, path: null } })
  w.core.start()
  await flush()
  assert.equal(w.upgradeView()?.action, 'swap')
  await w.run('start')
  await flush()
  assert.deepEqual(w.calls.install, [])
  assert.deepEqual(w.calls.stop, [true])
})

test('磁盘不足传到主界面且不停止旧服务，释放空间后可以重新安装', async () => {
  const diskSpace = {
    path: '/home/dev/.local/share/codex-harness-adapter',
    requiredKiB: 987654,
    availableKiB: 123,
  }
  let low = true
  const w = world({
    install: () =>
      low
        ? { ok: false, at: 'install', code: 28, said: 'tar: No space left on device', diskSpace }
        : { ok: true, installed: APP, said: null },
  })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  assert.deepEqual(w.upgradeView()?.phase, {
    step: 'failed',
    at: 'diskSpace',
    text: null,
    detail: 'tar: No space left on device',
    diskSpace,
  })
  assert.deepEqual(w.calls.stop, [])
  low = false
  await w.run('start')
  await flush()
  assert.equal(w.calls.install.length, 2)
  assert.deepEqual(w.calls.stop, [true])
  w.core.stop()
})

test('没做成的几种：下载失败、Homebrew 配方没跟上、服务太旧停不了、ssh 连不上', async () => {
  const download = world({
    install: () => ({ ok: false, at: 'download', code: 22, said: 'curl: (22) 404' }),
  })
  download.core.start()
  await flush()
  await download.run('start')
  await flush()
  assert.deepEqual(download.upgradeView()?.phase, {
    step: 'failed',
    at: 'download',
    text: null,
    detail: 'curl: (22) 404',
  })
  assert.deepEqual(download.calls.stop, [], '没装好就不去停')

  const brew = world({
    prepare(device) {
      device.service = facts('0.15.0', {
        root: '/opt/homebrew/Cellar/codex-harness-adapter/0.15.0/libexec',
      })
    },
    install: () => ({ ok: true, installed: '0.15.1', said: 'Upgrading codex-harness-adapter' }),
  })
  brew.core.start()
  await flush()
  assert.equal(brew.upgradeView()?.method, 'brew')
  await brew.run('start')
  await flush()
  assert.deepEqual(brew.calls.install, [{ method: 'brew', version: APP }])
  const phase = brew.upgradeView()?.phase
  assert.equal(phase?.step === 'failed' ? phase.at : null, 'behind')

  const legacy = world({ stops: [{ result: 'unsupported', said: '它不认识停止的请求' }] })
  legacy.core.start()
  await flush()
  await legacy.run('start')
  await flush()
  const said = legacy.upgradeView()?.phase
  assert.deepEqual(said, {
    step: 'failed',
    at: 'unsupported',
    text: null,
    detail: '它不认识停止的请求',
  })

  const lost = world({
    install: () => {
      throw new ConnectError('unreachable', phrase('ssh.unreachable'), true, 'Connection refused')
    },
  })
  lost.core.start()
  await flush()
  await lost.run('start')
  await flush()
  const gone = lost.upgradeView()?.phase
  assert.equal(gone?.step === 'failed' ? gone.at : null, 'connect')
  assert.equal(gone?.step === 'failed' ? gone.detail : null, 'Connection refused')
  // 没做成可以再来一次
  await assert.doesNotReject(lost.run('start'))
})

test('服务有别的东西管着：只装不换；认不出安装方式：不给做', async () => {
  const managed = world({
    prepare(device) {
      device.service = facts('0.15.0', { detached: false })
    },
  })
  managed.core.start()
  await flush()
  assert.equal(managed.upgradeView()?.managed, true)
  await managed.run('start')
  await flush()
  assert.equal(managed.calls.install.length, 1)
  assert.deepEqual(managed.calls.stop, [], '不替它停')
  assert.deepEqual(managed.upgradeView()?.phase, { step: 'restart' })
  // 用户自己重启之后：重连上来是新版
  managed.fake.service = facts(APP, { detached: false })
  await managed.core.command('device.reconnect', { deviceId: 'ssh-1' }, never)
  await flush()
  assert.equal(managed.upgradeView()?.phase.step, 'done')

  const odd = world({
    prepare(device) {
      device.service = facts('0.15.0', { root: '/opt/tyrs-hand/adapter' })
    },
  })
  odd.core.start()
  await flush()
  assert.equal(odd.upgradeView()?.method, null)
  await assert.rejects(odd.run('start'), /认不出/)
})

test('不比应用旧、比不出先后：没有这一项；手机端（没有能力）只说比应用旧', async () => {
  const same = world({
    prepare(device) {
      device.service = facts(APP)
    },
  })
  same.core.start()
  await flush()
  assert.equal(same.upgradeView(), null)
  assert.equal(same.calls.inspect, 0, '不旧就不去问')

  const newer = world({
    prepare(device) {
      device.service = facts('0.17.0')
    },
  })
  newer.core.start()
  await flush()
  assert.equal(newer.upgradeView(), null, '不降级')

  const phone = world({ incapable: true })
  phone.core.start()
  await flush()
  assert.equal(phone.upgradeView()?.capable, false)
  assert.equal(phone.upgradeView()?.running, '0.15.0')
  await assert.rejects(phone.run('start'), /不能替用户升级/)
})

test('旧到连不上（upgradeService）：按命令的位置认安装方式，同一个按钮', async () => {
  const w = world({
    failure: new ConnectError(
      'outdated',
      phrase('remote.serviceTooOld'),
      false,
      null,
      'upgradeService',
    ),
    installed: {
      version: null,
      path: '/home/dev/.local/share/codex-harness-adapter/0.5.1/bin/codex-harness-adapter',
    },
  })
  w.core.start()
  await flush()
  assert.equal(w.device().failure?.guide, 'upgradeService')
  const view = w.upgradeView()
  assert.equal(view?.running, null)
  assert.equal(view?.method, 'script')
  assert.equal(view?.action, 'upgrade')
  assert.equal(w.calls.inspect, 1)
})

test('一台远程安装失败不会阻塞另一台升级', async () => {
  const bad = world({ install: () => ({ ok: false, at: 'download', code: 22, said: 'offline' }) })
  const good = world()
  bad.core.start()
  good.core.start()
  try {
    await flush()
    await Promise.all([bad.run('start'), good.run('start')])
    await flush()
    assert.equal(bad.upgradeView()?.phase.step, 'failed')
    assert.equal(good.upgradeView()?.phase.step, 'done')
    assert.deepEqual(bad.calls.stop, [])
    assert.deepEqual(good.calls.stop, [true])
  } finally {
    bad.core.stop()
    good.core.stop()
  }
})

test('停服务后重连超时，给该设备失败结果而不是永久停在重连中', async () => {
  const w = world({ reconnectFailure: true })
  w.core.start()
  try {
    await flush()
    await w.run('start')
    await flush()
    assert.equal(w.upgradeView()?.phase.step, 'reconnecting')
    w.time.advance(120_000)
    await flush()
    assert.equal(w.upgradeView()?.phase.step, 'failed')
  } finally {
    w.core.stop()
  }
})
