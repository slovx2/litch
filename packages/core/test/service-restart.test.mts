// 重启设备服务：能不能做、先空闲时停还是直接停、停了之后重连、连回来换了一份才算成、
// 被打断的会话记下重启的时刻（再开始一个回合就去掉）、各种没做成。
// 真的核心对着假的聚合面（fake-device.mts），请服务停下的那一步换成按脚本应答的假能力；时钟是假的。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RESTART_WAIT_MS } from '../src/device/service-restart.mjs'
import {
  type AppOp,
  type AppView,
  ConnectError,
  createCore,
  type DeviceStore,
  type DeviceView,
  phrase,
  type RemotePlatform,
  type RemoteStopResult,
  type ServiceRestartSession,
  type ServiceRestartView,
  type SessionSummary,
  type SidebarOp,
  type SidebarView,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

/** 设备服务报的来历，照协议里的形状。pid 每次重启换一个 */
const facts = (pid: number, fields: Record<string, unknown> = {}) => ({
  pid,
  version: '0.20.0',
  root: '/home/dev/.local/share/codex-harness-adapter/0.20.0/libexec',
  startedAt: `2026-10-25T08:${String(pid % 60).padStart(2, '0')}:00Z`,
  detached: true,
  ...fields,
})

interface WorldOptions {
  /** 会话目录：默认一个闲着的 */
  threads?: ReturnType<typeof thread>[]
  /** 在跑的服务由前台或者服务管理器管着 */
  managed?: boolean
  /** 每次请停的应答，依次取；取完了就是“停了” */
  stops?: (RemoteStopResult | Error)[]
  /** 停了之后服务没换（还是原来那个进程） */
  sameAfterStop?: boolean
  /** 停了之后连不回来的原因 */
  failAfterStop?: ConnectError
  /** 外壳不给停服务的能力（手机端） */
  incapable?: boolean
}

function world(options: WorldOptions = {}) {
  const fake = fakeDevice([harness('pi', { threads: options.threads ?? [thread({ id: 'r1' })] })])
  fake.device.extensions = ['harness', 'deviceService']
  let pid = 1200
  fake.device.service = facts(pid, options.managed ? { detached: false } : {})
  const far = fakeOpener(fake.handlers)
  const stopped: boolean[] = []
  const stops = [...(options.stops ?? [])]
  let down = false
  const remote: RemotePlatform = {
    opener: () => async (signal) => {
      if (down && options.failAfterStop) throw options.failAfterStop
      return far.open(signal)
    },
    discover: async () => [],
    check: async () => ({
      ok: false,
      failure: { stage: 'unreachable', text: '', detail: null, retrying: false },
    }),
    ...(options.incapable
      ? {}
      : {
          async stopService(_target, ifIdle) {
            stopped.push(ifIdle)
            const next = stops.shift() ?? { result: 'stopped' }
            if (next instanceof Error) throw next
            if (next.result === 'stopped') {
              down = true
              if (!options.sameAfterStop) fake.device.service = facts(++pid)
              // 服务一停，连着的那条连接也断了
              far.last().drop()
            }
            return next
          },
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
  const core = createCore({ clock: time.clock, version: '0.20.0', remote, store, devices: [] })
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
  const rows = new Map<string, SessionSummary>()
  core.subscribe(
    { kind: 'sidebar', deviceId: 'ssh-1' },
    {
      snapshot: (data) => {
        for (const entry of (data as SidebarView).sessions) rows.set(entry.id, entry)
      },
      delta(ops) {
        for (const op of ops as SidebarOp[]) {
          if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
        }
      },
      error() {},
    },
  )
  const device = (): DeviceView => {
    if (!view) throw new Error('还没有设备的显示数据')
    return view
  }
  const restart = (): ServiceRestartView | null => device().restart
  const run = (mode: 'start' | 'force' | 'dismiss') =>
    core.command('device.restartService', { deviceId: 'ssh-1', mode }, never)
  const sessions = () =>
    core.command('device.restartSessions', { deviceId: 'ssh-1' }, never) as Promise<{
      sessions: ServiceRestartSession[]
    }>
  return { core, fake: fake.device, far, time, stopped, device, restart, run, sessions, rows }
}

const flush = async () => {
  for (let n = 0; n < 8; n++) await settle()
}

test('没有会话在跑：空闲时停，停了重连，连回来换了一份就算重启成了', async () => {
  const w = world()
  w.core.start()
  await flush()
  assert.deepEqual(w.restart(), { blocked: null, phase: { step: 'idle' } })
  assert.deepEqual((await w.sessions()).sessions, [])
  await w.run('start')
  await flush()
  assert.deepEqual(w.stopped, [true], '先带 ifIdle 请它停')
  assert.equal(w.far.servers.length, 2, '停了就重连了一次')
  const phase = w.restart()?.phase
  assert.equal(phase?.step, 'done')
  assert.equal(phase?.step === 'done' ? phase.interrupted : -1, 0)
  assert.equal(w.device().service?.pid, 1201, '连回来的是新的进程')
  // 收起结果
  await w.run('dismiss')
  assert.deepEqual(w.restart()?.phase, { step: 'idle' })
})

test('有会话在跑：列得出来；确认之后直接停，重启成了记下被打断的会话，再开始回合就去掉', async () => {
  const w = world({
    threads: [
      thread({ id: 'r1', name: '在跑的', status: { type: 'active', activeFlags: [] } }),
      thread({ id: 'r2', name: '闲着的' }),
    ],
  })
  w.core.start()
  await flush()
  const { sessions } = await w.sessions()
  assert.deepEqual(
    sessions.map((entry) => [entry.id, entry.running, entry.background]),
    [['r1', true, 0]],
  )
  await w.run('force')
  await flush()
  assert.deepEqual(w.stopped, [false], '确认过了：不等空闲')
  const phase = w.restart()?.phase
  assert.equal(phase?.step === 'done' ? phase.interrupted : -1, 1)
  assert.equal(typeof w.rows.get('r1')?.restarted, 'number', '被打断的会话记下了重启的时刻')
  assert.equal(w.rows.get('r2')?.restarted, undefined)
  // 它又开始了一个回合：记号去掉
  w.far.last().notify('thread/status/changed', {
    threadId: 'r1',
    status: { type: 'active', activeFlags: [] },
  })
  await flush()
  assert.equal(w.rows.get('r1')?.restarted, undefined)
})

test('服务说不闲：停在 busy 等用户决定；收起回到 idle，仍然重启就直接停', async () => {
  const busy = {
    result: 'busy' as const,
    busy: [{ reason: 'deviceProcesses', harnesses: [], count: 1 }],
  }
  const w = world({ stops: [busy, busy] })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  assert.deepEqual(w.restart()?.phase, { step: 'busy', busy: busy.busy })
  assert.equal(w.far.servers.length, 1, '没停：不重连')
  await w.run('dismiss')
  assert.deepEqual(w.restart()?.phase, { step: 'idle' })
  await w.run('start')
  await flush()
  assert.equal(w.restart()?.phase.step, 'busy')
  await w.run('force')
  await flush()
  assert.deepEqual(w.stopped, [true, true, false])
  assert.equal(w.restart()?.phase.step, 'done')
})

test('没停成：连不上那台机器、服务太旧、旧服务、停了没退出，各记各的原因，不重连', async () => {
  const unreachable = new ConnectError(
    'unreachable',
    phrase('ssh.unreachable'),
    true,
    'ssh: timeout',
  )
  const w = world({
    stops: [
      unreachable,
      { result: 'unsupported', said: 'control socket refused' },
      { result: 'legacy', said: null },
      { result: 'failed', said: 'still running after 45s' },
    ],
  })
  w.core.start()
  await flush()
  const seen: string[] = []
  for (let n = 0; n < 4; n++) {
    await w.run('start')
    await flush()
    const phase = w.restart()?.phase
    assert.equal(phase?.step, 'failed')
    if (phase?.step === 'failed') seen.push(`${phase.reason}:${phase.detail ?? ''}`)
  }
  assert.deepEqual(seen, [
    'connect:ssh: timeout',
    'unsupported:control socket refused',
    'legacy:',
    'stop:still running after 45s',
  ])
  assert.equal(w.far.servers.length, 1)
  assert.equal(w.device().connection, 'online')
})

test('停了之后连不回来：照连接的原因说没做成', async () => {
  const w = world({
    failAfterStop: new ConnectError(
      'startFailed',
      phrase('connect.adapterStartFailed'),
      false,
      'boom',
    ),
  })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  const phase = w.restart()?.phase
  assert.equal(phase?.step, 'failed')
  if (phase?.step !== 'failed') return
  assert.equal(phase.reason, 'start')
  assert.deepEqual(phase.text, phrase('connect.adapterStartFailed'))
  assert.equal(phase.detail, 'boom')
  assert.equal(w.restart()?.blocked, 'offline', '没连着：不能再点')
})

test('连回来的还是原来那一份：等到点算没做成', async () => {
  const w = world({ sameAfterStop: true })
  w.core.start()
  await flush()
  await w.run('start')
  await flush()
  assert.equal(w.restart()?.phase.step, 'starting', '连回来的是原来的进程：先不算成')
  w.time.advance(RESTART_WAIT_MS)
  await flush()
  const phase = w.restart()?.phase
  assert.equal(phase?.step === 'failed' ? phase.reason : phase?.step, 'stale')
})

test('做不了的：服务有别的东西管着、没连上；上一次没做完不能再来；外壳没给能力就没有这一项', async () => {
  const managed = world({ managed: true })
  managed.core.start()
  await flush()
  assert.equal(managed.restart()?.blocked, 'managed')
  await assert.rejects(managed.run('start'), /现在不能重启设备服务/)
  assert.deepEqual(managed.stopped, [])

  const offline = world()
  assert.equal(offline.restart()?.blocked, 'offline', '还没连上')

  const twice = world({ sameAfterStop: true })
  twice.core.start()
  await flush()
  await twice.run('start')
  await flush()
  await assert.rejects(twice.run('force'), /上一次重启还没有做完/)

  const phone = world({ incapable: true })
  phone.core.start()
  await flush()
  assert.equal(phone.restart(), null)
  await assert.rejects(phone.run('start'), /不能重启/)
})
