// 模拟核心里的“设备服务”：示例数据里各台设备在跑的是哪一份，对话里的关键字演的几出换版本的情形，
// 和“现在再试一次”——界面在浏览器里对着它调，窗口验收的头一半也对着它跑。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AppOp,
  connectChannel,
  createMockCore,
  createPortPair,
  type DeviceView,
  type SampleLang,
  serveChannel,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

/** 一个不拖时间的模拟核心（chunkMs 是 0），设备的显示数据像界面那样把快照和增量落下来 */
function setup(lang: SampleLang = 'zh-CN') {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  const core = createMockCore({ clock: time.clock, chunkMs: 0, lang })
  serveChannel(corePort, core, { clock: time.clock })
  const channel = connectChannel(uiPort)
  const devices = new Map<string, DeviceView>()
  /** 本机每一次变化之后的连接状态，按先后 */
  const states: string[] = []
  channel.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        for (const device of data.devices) devices.set(device.id, device)
      },
      delta(ops: AppOp[]) {
        for (const op of ops) {
          if (op.op !== 'device.upsert') continue
          devices.set(op.device.id, op.device)
          if (op.device.id === 'local') states.push(op.device.connection)
        }
      },
    },
  )
  /** 等刚发的命令送到，再让时间走一段：增量是按帧合并发送的，要过一帧界面才收得到 */
  const flush = async (ms = 16) => {
    await settle()
    time.advance(ms)
    await settle()
  }
  const local = (): DeviceView => devices.get('local') as DeviceView
  const say = (sessionId: string, text: string, deviceId = 'local') =>
    channel.command('session.send', { deviceId, sessionId, text })
  const retry = () => channel.command('device.reconnect', { deviceId: 'local' })
  return { channel, devices, states, flush, local, say, retry }
}

test('示例数据：本机在跑的就是应用自带的那一份；远程的看得到是哪一份；没有设备服务的、没连上的没有', async () => {
  const { devices, local } = setup()
  await settle()
  const { service, upgrade } = local()
  assert.equal(service?.version, '0.7.0')
  assert.equal(service?.detached, true)
  assert.equal(service?.root, upgrade?.bundled.root, '就是从应用自带的那份适配器起的')
  assert.deepEqual([upgrade?.action, upgrade?.reason, upgrade?.order], ['kept', 'same', 'same'])

  const build = devices.get('build')
  assert.equal(build?.service?.detached, false)
  assert.ok(build?.service?.root.startsWith('/home/dev/'))
  assert.equal(build?.upgrade, null, '远程设备上应用不替用户换版本')
  for (const id of ['nas', 'gpu']) {
    assert.equal(devices.get(id)?.service, null, id)
    assert.equal(devices.get(id)?.upgrade, null, id)
  }
})

test('对话里的关键字各演一出：换了新版、旧而忙、前台的、太旧、没停成、比应用新', async () => {
  const seen: Record<string, unknown[]> = {}
  for (const words of [
    '服务换了新版',
    '服务旧而忙',
    '服务是前台的',
    '服务太旧',
    '服务没停成',
    '服务比应用新',
  ]) {
    const { say, flush, local } = setup()
    await settle()
    // s4 是本机上一个闲着的 DeepSeek Harness 会话
    await say('s4', `演一出：${words}`)
    await flush()
    const { service, upgrade } = local()
    seen[words] = [
      upgrade?.action,
      upgrade?.reason,
      upgrade?.order,
      upgrade?.previous,
      service?.version ?? null,
      service?.detached ?? null,
    ]
    if (words === '服务旧而忙') {
      // 头一回的原因里：正在跑的回合（示例里 Claude Code 的两个，加上刚发话的这一个），再编上一个终端、一个别的客户端
      assert.deepEqual(
        upgrade?.busy.map((entry) => [entry.reason, [...entry.harnesses].sort(), entry.count]),
        [
          ['activeTurns', ['claude', 'dsh'], 0],
          ['deviceProcesses', [], 1],
          ['clients', [], 1],
        ],
      )
    } else assert.deepEqual(upgrade?.busy, [], words)
    if (words === '服务太旧') {
      assert.equal(upgrade?.pid, 4821)
      assert.match(upgrade?.detail ?? '', /它不认识停止的请求.*4821/)
    }
    if (words === '服务没停成') assert.match(upgrade?.detail ?? '', /没有退出/)
    if (words === '服务换了新版') assert.equal(service?.root, upgrade?.bundled.root)
  }
  assert.deepEqual(seen, {
    服务换了新版: ['replaced', null, 'older', '0.6.0', '0.7.0', true],
    服务旧而忙: ['kept', 'busy', 'older', '0.6.0', '0.6.0', true],
    服务是前台的: ['kept', 'foreground', 'older', '0.6.0', '0.6.0', false],
    // 太旧的服务连自己的来历都不报
    服务太旧: ['kept', 'unsupported', 'unknown', null, null, null],
    服务没停成: ['kept', 'failed', 'older', '0.6.0', '0.6.0', true],
    服务比应用新: ['kept', 'newer', 'newer', '0.8.0', '0.8.0', true],
  })
})

test('英文的关键字同样认，命令行的原话跟着示例数据的语言；远程设备的会话里发不演', async () => {
  const english = setup('en')
  await settle()
  await english.say('s4', 'pretend the service is too old')
  await english.flush()
  assert.equal(english.local().upgrade?.reason, 'unsupported')
  assert.match(english.local().upgrade?.detail ?? '', /does not understand the stop request/)

  const remote = setup()
  await settle()
  const before = remote.local().upgrade
  // b2 是远程那台设备上一个闲着的会话
  await remote.say('b2', '服务旧而忙', 'build')
  await remote.flush()
  assert.deepEqual(remote.local().upgrade, before)
  assert.equal(remote.devices.get('build')?.upgrade, null)
})

test('现在再试一次：还有回合在跑就照旧没换，原因换成现在的；都闲了才换成应用自带的', async () => {
  const { channel, say, flush, local, retry, states } = setup()
  await settle()
  await say('s4', '服务旧而忙')
  await flush()
  const stale = local().service
  assert.equal(local().upgrade?.reason, 'busy')
  assert.equal(local().upgrade?.busy.length, 3)

  // 刚发话的那个回合已经结束，Claude Code 的两个会话还一个在跑、一个在等审批
  states.length = 0
  await retry()
  await flush()
  assert.deepEqual(states, ['reconnecting', 'online'], '和真的一样：重新连了一次')
  assert.equal(local().upgrade?.reason, 'busy')
  assert.deepEqual(local().upgrade?.busy, [
    { reason: 'activeTurns', harnesses: ['claude'], count: 0 },
  ])
  assert.deepEqual(local().service, stale, '在跑的还是原来那一份')

  // 把 Claude Code 上的回合都了结（强行重启它），再试：这回闲着，换掉了
  await channel.command('device.harness.restart', {
    deviceId: 'local',
    harness: 'claude',
    force: true,
  })
  await flush()
  states.length = 0
  await retry()
  await flush()
  assert.deepEqual(
    states.filter((state, at) => state !== states[at - 1]),
    ['reconnecting', 'online'],
  )
  assert.deepEqual(
    [local().upgrade?.action, local().upgrade?.reason, local().upgrade?.previous],
    ['replaced', null, '0.6.0'],
  )
  assert.equal(local().service?.version, '0.7.0')
  assert.notEqual(local().service?.pid, stale?.pid, '换了一个进程')

  // 换成之后“重新连接”不再归这一出管：连着的本机照旧不动
  states.length = 0
  await retry()
  await flush()
  assert.deepEqual(states, [])
  assert.equal(local().upgrade?.action, 'replaced')
})

test('别的没换成的情形没有“再试一次”：重新连接不会把它们演成换上了', async () => {
  for (const words of ['服务是前台的', '服务太旧', '服务没停成']) {
    const { say, flush, local, retry, states } = setup()
    await settle()
    await say('s4', words)
    await flush()
    const before = local().upgrade
    states.length = 0
    await retry()
    await flush()
    assert.deepEqual(states, [], words)
    assert.deepEqual(local().upgrade, before, words)
  }
})

test('远程设备的一键升级四出：马上换上、等空闲（还有回合等人就照旧等，立即换上不等）、下载失败、配方没跟上', async () => {
  const { channel, devices, flush, say } = setup()
  await settle()
  const build = () => devices.get('build') as DeviceView
  const run = (mode: 'start' | 'retry' | 'force') =>
    channel.command('device.upgradeService', { deviceId: 'build', mode })
  const until = async (step: string) => {
    for (let n = 0; n < 40 && build().remoteUpgrade?.phase.step !== step; n++) await flush(200)
    assert.equal(build().remoteUpgrade?.phase.step, step)
  }
  assert.equal(build().remoteUpgrade, null, '平时和应用是同一版')
  await assert.rejects(run('start'))

  await say('b2', '远程服务旧', 'build')
  await flush()
  assert.deepEqual(
    [build().remoteUpgrade?.running, build().remoteUpgrade?.target, build().remoteUpgrade?.method],
    ['0.6.0', '0.7.0', 'script'],
  )
  await run('start')
  await until('done')
  assert.equal(build().service?.version, '0.7.0')
  assert.equal(build().connection, 'online')

  // b1 上有一个请求停着等人：一直不闲
  await say('b2', '远程服务旧而忙', 'build')
  await flush()
  await run('start')
  await until('waiting')
  const waiting = build().remoteUpgrade?.phase
  assert.ok(
    waiting?.step === 'waiting' && waiting.busy.some((entry) => entry.reason === 'activeTurns'),
  )
  await run('retry')
  await flush()
  await until('waiting')
  assert.equal(build().service?.version, '0.6.0', '还在等：旧的接着用')
  await run('force')
  await until('done')

  await say('b2', '远程下载失败', 'build')
  await flush()
  await run('start')
  await until('failed')
  const download = build().remoteUpgrade?.phase
  assert.equal(download?.step === 'failed' ? download.at : null, 'download')

  await say('b2', 'remote formula is behind', 'build')
  await flush()
  assert.equal(build().remoteUpgrade?.method, 'brew')
  await run('start')
  await until('failed')
  const behind = build().remoteUpgrade?.phase
  assert.equal(behind?.step === 'failed' ? behind.at : null, 'behind')
  assert.equal(build().remoteUpgrade?.installed, '0.6.1')
})
