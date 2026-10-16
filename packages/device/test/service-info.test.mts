// 常驻服务的来历和忙闲在设备进程这一侧（service-info.mts）：
// 来历是主进程经控制通道给的，只转述给声明了 deviceService 扩展的连接；
// 主进程来问忙不忙（device-stop --if-idle 之前），答的是回合、属于设备的终端、聚合面上的连接这三样。
// 主进程由进程内的假控制通道扮演；真的主进程在 service-version.test.mts。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagedHarnessState } from '../../protocol/src/device-settings.mjs'
import type { ControlState } from '../src/control.mjs'
import { type DeviceActivity, serviceInfo } from '../src/service-info.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeUpstream, RpcFailure } from './fake-upstream.mjs'
import { assertDeviceService, assertRuntimeInfo, rig, settle } from './helpers.mjs'
import { OPEN, SLEEP } from './process-kit.mjs'

const SERVICE = {
  pid: 4242,
  version: '1.4.0',
  root: '/opt/litch/adapter',
  startedAt: '2026-10-13T08:00:00Z',
  detached: true,
  build: '1760342400000000000-7340032',
}
/** 握手时声明了这项扩展的 */
const AWARE = ['harness', 'deviceService']
const ACTIVE = { id: 'busy', updatedAt: 5, status: { type: 'active', activeFlags: [] } }

async function idle(done: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒没有等到：${what}`)
    await settle(20)
  }
}

/** 一台由主进程管着的设备。service 是主进程报的自己的来历，null 是没有报 */
function setup(
  states: Record<string, ManagedHarnessState>,
  service: ControlState['service'] | null = null,
) {
  const fakes: Record<string, FakeUpstream> = {}
  for (const id of Object.keys(states)) fakes[id] = new FakeUpstream(id)
  const control = new FakeControl(
    Object.entries(states).map(([id, state]) => managed(id, state)),
    false,
  )
  control.service = service
  control.push()
  const device = rig(
    {},
    {},
    {
      control,
      dial: (socket) => (fakes[socket.slice('fake://'.length)] as FakeUpstream).connector,
    },
  )
  const activity = () => control.ask('activity') as Promise<DeviceActivity>
  return { ...device, control, fakes, activity }
}

test('runtime/info 的 device.service：声明了 deviceService 的连接才有，说的就是主进程报的那一份', async () => {
  // 主进程多给的启动参数只在本机用，不带给客户端
  const { connect, close } = setup({ pi: 'running' }, { ...SERVICE, options: ['--ssh=off'] })
  try {
    const aware = connect()
    await aware.initialize(AWARE)
    const info = await aware.call('runtime/info')
    assert.ok(info.device.extensions.includes('deviceService'), '设备信息里列出了这项扩展')
    assert.deepEqual(info.device.service, SERVICE)
    assertDeviceService(info.device.service)
    // 多了这个字段的应答，和 harness 扩展的定义也对得上
    assertRuntimeInfo(info)

    // 没声明的连接：没有这个字段，别的一样
    const plain = connect()
    await plain.initialize()
    const seen = await plain.call('runtime/info')
    assertRuntimeInfo(seen)
    assert.equal('service' in seen.device, false)
    const { service: _service, ...rest } = info.device
    assert.deepEqual(seen.device, rest)
    assert.ok(!plain.raw.join('\n').includes(SERVICE.root), '没声明的连接上一个字都没有多')
  } finally {
    await close()
  }
})

test('主进程的来历还没到、报得不成样子：声明了的连接上也没有 service，不说一半', async () => {
  const { connect, control, close } = setup({ pi: 'running' })
  try {
    const client = connect()
    await client.initialize(AWARE)
    const service = async () => (await client.call('runtime/info')).device.service
    assert.equal(await service(), undefined, '没有报')
    for (const broken of [
      { ...SERVICE, version: '' },
      { ...SERVICE, pid: '4242' },
      { ...SERVICE, detached: undefined },
      { version: '1.4.0' },
    ]) {
      control.service = broken as unknown as ControlState['service']
      control.push()
      assert.equal(await service(), undefined, JSON.stringify(broken))
    }
    // 之后到了像样的一份：再问就有了
    const { build: _build, ...withoutBuild } = SERVICE
    control.service = withoutBuild
    control.push()
    assert.deepEqual(await service(), withoutBuild, '程序文件的戳取不到时没有那一项')
    assertDeviceService(await service())
  } finally {
    await close()
  }
})

test('没有主进程在管：设备信息里不列这项扩展，声明了也没有 service', async () => {
  const { connect, close } = rig({ pi: new FakeUpstream('pi') })
  try {
    const client = connect()
    await client.initialize(AWARE)
    const info = await client.call('runtime/info')
    assert.ok(!info.device.extensions.includes('deviceService'))
    assert.equal('service' in info.device, false)
  } finally {
    await close()
  }
})

test('serviceInfo 只取对客户端报的那几项', () => {
  const state = (service: unknown) => ({ service }) as unknown as ControlState
  assert.equal(serviceInfo(null), null)
  assert.equal(serviceInfo(state(undefined)), null)
  assert.equal(serviceInfo(state('1.4.0')), null)
  assert.equal(serviceInfo(state({ ...SERVICE, pid: 1.5 })), null)
  assert.deepEqual(serviceInfo(state({ ...SERVICE, options: ['--ssh=on'], extra: 1 })), SERVICE)
  assert.deepEqual(serviceInfo(state({ ...SERVICE, build: '' })), {
    pid: SERVICE.pid,
    version: SERVICE.version,
    root: SERVICE.root,
    startedAt: SERVICE.startedAt,
    detached: true,
  })
})

test('主进程问忙不忙：答的是有回合在跑的 harness、属于设备的终端、聚合面上的连接', async () => {
  const { connect, fakes, activity, stateDir, close } = setup({
    'claude-code': 'running',
    pi: 'running',
    dsh: 'disabled',
  })
  try {
    assert.deepEqual(await activity(), { turns: [], processes: 0, connections: 0 }, '闲着')
    assert.equal(fakes.dsh?.connections.length, 0, '没在跑的运行时不去问')

    // 回合：哪怕聚合面上一个客户端都没有，也问得出来（回合可能是官方桌面端经 SSH 入口发起的）
    const claude = fakes['claude-code'] as FakeUpstream
    const pi = fakes.pi as FakeUpstream
    claude.threads = [ACTIVE]
    assert.deepEqual(await activity(), { turns: ['claude-code'], processes: 0, connections: 0 })
    // 问不出来的按有算，顺序照对外报告的顺序
    const listing = pi.handlers['thread/list'] as NonNullable<(typeof pi.handlers)[string]>
    pi.handlers['thread/list'] = () => {
      throw new RpcFailure(-32603, 'boom')
    }
    assert.deepEqual((await activity()).turns, ['claude-code', 'pi'])
    claude.threads = []
    pi.handlers['thread/list'] = listing
    assert.deepEqual((await activity()).turns, [])

    // 连接
    const first = connect()
    await first.initialize(['harness', 'deviceProcesses'])
    const second = connect()
    await second.initialize()
    assert.deepEqual(await activity(), { turns: [], processes: 0, connections: 2 })
    second.close()
    await idle(async () => (await activity()).connections === 1, '第二条连接走了')

    // 属于设备的终端：起它的那条连接走了，它还在跑，还算忙
    await first.call('process/spawn', {
      processHandle: 'kept',
      command: SLEEP,
      cwd: stateDir,
      ...OPEN,
      litchDevice: {},
    })
    // 属于连接的进程不另数：它随连接走，有连接在就已经算忙了
    await first.call('process/spawn', { processHandle: 'own', command: SLEEP, cwd: stateDir })
    assert.deepEqual(await activity(), { turns: [], processes: 1, connections: 1 })
    first.close()
    await idle(async () => (await activity()).connections === 0, '起它的那条连接走了')
    assert.deepEqual(await activity(), { turns: [], processes: 1, connections: 0 })

    const again = connect()
    await again.initialize(['harness', 'deviceProcesses'])
    await again.call('litch/process/kill', { processHandle: 'kept' })
    again.close()
    await idle(async () => {
      const now = await activity()
      return now.processes === 0 && now.connections === 0
    }, '终端结束了，连接也走了')
    assert.deepEqual(await activity(), { turns: [], processes: 0, connections: 0 }, '又闲了')
  } finally {
    await close()
  }
})

test('主进程问了不认识的事：答不上，不是随便给一个', async () => {
  const { control, close } = setup({ pi: 'running' })
  try {
    await assert.rejects(control.ask('nonsense'), /不认识/)
  } finally {
    await close()
  }
  // 设备关了以后没有人接
  await assert.rejects(control.ask('activity'), /没有人接/)
})
