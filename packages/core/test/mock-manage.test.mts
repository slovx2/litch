// 模拟核心里的设备与 harness 管理：界面在浏览器里对着它调，窗口验收的头一半也对着它跑，
// 所以它的行为要和真的设备服务一个样——全有或全无、冲突不覆盖、待重启、密钥不留。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AppOp,
  type ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  type DeviceView,
  type ManageOp,
  type ManageView,
  type SessionSummary,
  type SidebarOp,
  serveChannel,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

/** chunkMs 是模拟核心里“过一会儿”的单位；0 表示什么都不拖 */
function setup(chunkMs = 0) {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs }), { clock: time.clock })
  const channel = connectChannel(uiPort)

  const devices = new Map<string, DeviceView>()
  channel.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        for (const device of data.devices) devices.set(device.id, device)
      },
      delta(ops: AppOp[]) {
        for (const op of ops) if (op.op === 'device.upsert') devices.set(op.device.id, op.device)
      },
    },
  )
  const rows = new Map<string, SessionSummary>()
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        for (const entry of data.sessions) rows.set(entry.id, entry)
      },
      delta(ops: SidebarOp[]) {
        for (const op of ops) {
          if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
          else if (op.op === 'session.remove') rows.delete(op.sessionId)
        }
      },
    },
  )
  /** 订阅一台设备的管理数据。给界面的一切都留在 seen 里 */
  const watch = (deviceId = 'local') => {
    const seen = {
      view: null as ManageView | null,
      snapshots: 0,
      ops: [] as Extract<ManageOp, { op: 'settings.set' }>[],
      errors: [] as ChannelError[],
    }
    const close = channel.subscribe(
      { kind: 'manage', deviceId },
      {
        snapshot(data) {
          seen.view = structuredClone(data)
          seen.snapshots++
        },
        delta(ops: ManageOp[]) {
          for (const op of ops) {
            assert.equal(op.op, 'settings.set')
            if (op.op !== 'settings.set') continue
            seen.ops.push(structuredClone(op))
            if (seen.view) seen.view.snapshot = structuredClone(op.snapshot)
          }
        },
        error: (error) => seen.errors.push(error),
      },
    )
    return { seen, close }
  }
  /** 等刚发的命令送到，再让时间走一段：增量是按帧合并发送的，要过一帧界面才收得到 */
  const flush = async (ms = 16) => {
    await settle()
    time.advance(ms)
    await settle()
  }
  const harness = (id: string, deviceId = 'local') =>
    devices.get(deviceId)?.harnesses.find((entry) => entry.id === id)
  const say = (sessionId: string, text: string) =>
    channel.command('session.send', { deviceId: 'local', sessionId, text })
  return { channel, time, devices, rows, watch, flush, harness, say }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

/** 连上并打开本机的管理数据 */
async function opened(chunkMs = 0) {
  const world = setup(chunkMs)
  await settle()
  const { seen, close } = world.watch()
  await settle()
  const view = seen.view as ManageView
  assert.ok(view, '本机的管理数据')
  const write = (edits: { key: string; value: unknown }[], expectedVersion?: number) =>
    world.channel.command('device.settings.write', {
      deviceId: 'local',
      expectedVersion: expectedVersion ?? (seen.view as ManageView).snapshot.version,
      edits: edits as never,
    })
  return { ...world, seen, close, view, write }
}

test('示例数据：每种类型的设置都有，还有一项这一版不认识的；入口有开着的、起不来的、关着的', async () => {
  const { view } = await opened()
  const types = new Set(view.settings.map((entry) => entry.type))
  for (const type of [
    'boolean',
    'string',
    'integer',
    'enum',
    'path',
    'env',
    'secret',
    'schedule',
  ]) {
    assert.ok(types.has(type), `有 ${type} 类型的设置`)
  }
  // 每一项都指得到一个分组，标题两种语言都有
  const groups = new Set(view.groups.map((group) => group.id))
  for (const entry of view.settings) {
    assert.ok(groups.has(entry.group), entry.key)
    assert.ok(entry.title['zh-CN'] && entry.title.en, entry.key)
  }
  assert.deepEqual(
    view.snapshot.sshEntries.map((entry) => [entry.harness, entry.state]),
    [
      ['claude', 'listening'],
      ['pi', 'failed'],
      ['dsh', 'off'],
      // codex 的入口没开；开了也起不来，它的运行时不在
      ['codex', 'off'],
    ],
  )
  const failed = view.snapshot.sshEntries.find((entry) => entry.state === 'failed')
  assert.equal(failed?.reason?.kind, 'portUnavailable')
  assert.ok(failed?.reason?.text.en && failed.reason.text['zh-CN'])
})

test('哪些设备能管理：没有设置接口的订阅不上；没连上的订阅得上但没有内容，命令说没连上', async () => {
  const { devices, watch, channel } = setup()
  await settle()
  assert.deepEqual(
    [...devices.values()].map((device) => [device.id, device.manageable]),
    [
      ['local', true],
      ['build', true],
      ['nas', false],
      ['gpu', true],
    ],
  )
  const nas = watch('nas')
  const gpu = watch('gpu')
  const build = watch('build')
  await settle()
  assert.deepEqual(
    nas.seen.errors.map((error) => error.code),
    ['unsupported'],
  )
  assert.equal(gpu.seen.snapshots, 0)
  assert.deepEqual(gpu.seen.errors, [])
  // 远程那台一开始就有一个 harness 等着重启
  assert.deepEqual(build.seen.view?.snapshot.pendingRestart, ['pi'])
  const offline = await failureOf(channel.command('device.diagnostics.run', { deviceId: 'gpu' }))
  assert.equal(offline.code, 'offline')
  const none = await failureOf(channel.command('device.sshConfig.read', { deviceId: 'nas' }))
  assert.equal(none.code, 'unsupported')
})

test('停用一个 harness：它的状态变成停用，会话都留着但发不出去、建不了新的；再启用就恢复', async () => {
  const { write, harness, rows, channel, flush, seen } = await opened()
  const mine = () => [...rows.values()].filter((row) => row.harness === 'pi').map((row) => row.id)
  const before = mine()
  assert.ok(before.length > 0)

  const result = await write([{ key: 'harness.pi.enabled', value: false }])
  assert.deepEqual(result, {
    changed: ['harness.pi.enabled'],
    restarted: ['pi'],
    pendingRestart: [],
  })
  await flush()
  assert.equal(harness('pi')?.state, 'disabled')
  assert.deepEqual(harness('pi')?.reason, { key: 'harness.disabled' })
  assert.equal(seen.view?.snapshot.values['harness.pi.enabled'], false)
  assert.deepEqual(mine(), before, '已有的会话还在侧栏里')
  const create = await failureOf(
    channel.command('session.create', {
      deviceId: 'local',
      cwd: null,
      text: '开一个',
      harness: 'pi',
    }),
  )
  assert.deepEqual(create.text, { key: 'fault.harnessUnavailable', args: { name: 'Pi' } })
  const send = await failureOf(
    channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '在吗' }),
  )
  assert.deepEqual(send.text, { key: 'fault.harnessUnavailable', args: { name: 'Pi' } })
  // 它的入口跟着落下去
  assert.equal(
    seen.view?.snapshot.sshEntries.find((entry) => entry.harness === 'pi')?.state,
    'idle',
  )

  await write([{ key: 'harness.pi.enabled', value: true }])
  await flush()
  assert.equal(harness('pi')?.state, 'ready')
  assert.equal(harness('pi')?.reason, null)
  assert.deepEqual(mine(), before)
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '在吗' })
})

test('改了要重启才生效的设置而它有回合在跑：不打断，标成待重启；重启要明说照做', async () => {
  const { write, harness, rows, channel, flush, seen } = await opened()
  // 示例里 claude 一开始就有一个回合在跑、一个停着等批准
  assert.equal(rows.get('s1')?.status, 'running')
  assert.equal(rows.get('s2')?.status, 'waiting')
  const result = await write([{ key: 'harness.claude.cliPath', value: '/opt/claude/bin/claude' }])
  assert.deepEqual(result.restarted, [])
  assert.deepEqual(result.pendingRestart, ['claude'])
  await flush()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, ['claude'])
  assert.equal(harness('claude')?.state, 'ready', '没有动它')
  assert.equal(rows.get('s1')?.status, 'running')

  // 不要重启的设置：立刻生效，不牵扯待重启
  const light = await write([{ key: 'harness.claude.idleExitMinutes', value: 5 }])
  assert.deepEqual([light.restarted, light.pendingRestart], [[], ['claude']])

  const busy = await failureOf(
    channel.command('device.harness.restart', { deviceId: 'local', harness: 'claude' }),
  )
  assert.equal(busy.code, 'busy')
  assert.ok(busy.said?.['zh-CN'].includes('Claude Code') && busy.said.en.includes('Claude Code'))
  await flush()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, ['claude'])
  assert.equal(rows.get('s1')?.status, 'running', '什么都没打断')

  const done = await channel.command('device.harness.restart', {
    deviceId: 'local',
    harness: 'claude',
    force: true,
  })
  assert.deepEqual(done, { running: true, text: null })
  await flush()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, [])
  assert.equal(rows.get('s1')?.status, 'idle', '在跑的回合被打断了')
  assert.equal(rows.get('s2')?.status, 'idle')
  assert.equal(rows.get('s2')?.waitingFor, null)
})

test('密钥：写进去之后哪儿都读不回来，只知道“设过了”；不带值再写一遍是保持原样', async () => {
  const { write, seen, flush, channel } = await opened()
  const before = seen.view as ManageView
  // 一开始就存着的密钥也一样：只有“设过了”
  assert.deepEqual(before.snapshot.values['harness.pi.apiKey'], { set: true })
  assert.deepEqual(before.snapshot.values['harness.claude.env'], [
    { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
    { name: 'ANTHROPIC_API_KEY', secret: true },
  ])
  assert.deepEqual(
    before.inheritedEnv.find((entry) => entry.secret),
    { name: 'OPENAI_API_KEY', secret: true },
  )

  const result = await write([
    { key: 'harness.pi.apiKey', value: 'sk-MOCK-one' },
    {
      key: 'harness.dsh.env',
      value: [
        { name: 'DSH_REGION', value: 'cn-east' },
        // 标了密钥的，和名字像密钥、没标的
        { name: 'DSH_EXTRA', value: 'sk-MOCK-two', secret: true },
        { name: 'DEEPSEEK_API_KEY', value: 'sk-MOCK-three' },
      ],
    },
  ])
  // 密钥换了一个新的也算变了，哪怕读出来的样子没变
  assert.deepEqual(result.changed.sort(), ['harness.dsh.env', 'harness.pi.apiKey'])
  await flush(400)
  assert.deepEqual(seen.view?.snapshot.values['harness.pi.apiKey'], { set: true })
  assert.deepEqual(seen.view?.snapshot.values['harness.dsh.env'], [
    { name: 'DSH_REGION', value: 'cn-east' },
    { name: 'DSH_EXTRA', secret: true },
    { name: 'DEEPSEEK_API_KEY', secret: true },
  ])

  // 界面把读到的表原样写回去（密钥不带值）：保持原样；新加的密钥不带值不行
  const again = await write([
    {
      key: 'harness.dsh.env',
      value: [
        { name: 'DSH_REGION', value: 'cn-north' },
        { name: 'DSH_EXTRA', secret: true },
        { name: 'DEEPSEEK_API_KEY', secret: true },
      ],
    },
  ])
  assert.deepEqual(again.changed, ['harness.dsh.env'])
  await flush(400)
  const missing = await failureOf(
    write([{ key: 'harness.dsh.env', value: [{ name: 'NEW_TOKEN', secret: true }] }]),
  )
  assert.equal(missing.code, 'invalid')

  // 之后再读什么，都读不到写进去的那几个密钥
  await flush(400)
  const diagnostics = await (async () => {
    const run = channel.command('device.diagnostics.run', { deviceId: 'local' })
    await flush(400)
    return run
  })()
  const logs = await Promise.all(
    (['device', 'service', 'runtime', 'diagnostics'] as const).map((source) =>
      channel.command('device.logs.read', { deviceId: 'local', source, harness: 'dsh' }),
    ),
  )
  const config = await channel.command('device.sshConfig.read', { deviceId: 'local' })
  const reopened = setupWatchOn(channel)
  await settle()
  const everything = JSON.stringify([
    seen,
    result,
    again,
    missing.said,
    diagnostics,
    logs,
    config,
    reopened,
  ])
  assert.ok(!everything.includes('sk-MOCK'), '写进去的密钥没有出现在任何给界面的东西里')
})

/** 在同一条通道上再订阅一次本机的管理数据，收下它给的一切 */
function setupWatchOn(channel: ReturnType<typeof setup>['channel']): unknown[] {
  const got: unknown[] = []
  channel.subscribe(
    { kind: 'manage', deviceId: 'local' },
    { snapshot: (data) => got.push(data), delta: (ops) => got.push(ops) },
  )
  return got
}

test('一次写入全有或全无：里面有一项不合规矩，别的也不落；说得出是哪一项', async () => {
  const { write, seen, flush } = await opened()
  const version = seen.view?.snapshot.version
  const failure = await failureOf(
    write([
      { key: 'terminal.scrollback', value: 5000 },
      // 和 claude 入口的端口相同
      { key: 'ssh.dsh.port', value: 22230 },
    ]),
  )
  assert.equal(failure.code, 'invalid')
  assert.equal(failure.key, 'ssh.dsh.port')
  assert.ok(failure.said?.['zh-CN'] && failure.said.en)
  await flush()
  assert.equal(seen.view?.snapshot.version, version)
  assert.equal(seen.view?.snapshot.values['terminal.scrollback'], 10000)
  assert.equal(seen.ops.length, 0)

  for (const [edit, key] of [
    [{ key: 'terminal.scrollback', value: 10 }, 'terminal.scrollback'],
    [{ key: 'harness.claude.cliPath', value: 'bin/claude' }, 'harness.claude.cliPath'],
    [{ key: 'harness.claude.logLevel', value: 'loud' }, 'harness.claude.logLevel'],
    [{ key: 'harness.dsh.wakeSchedule', value: 'daily' }, 'harness.dsh.wakeSchedule'],
    [{ key: 'nope.nothing', value: true }, 'nope.nothing'],
  ] as const) {
    const invalid = await failureOf(write([edit]))
    assert.deepEqual([invalid.code, invalid.key], ['invalid', key])
  }

  // 互换两个入口的端口：一项一项改过不去，一次写入才成立
  const swapped = await write([
    { key: 'ssh.claude.port', value: 22232 },
    { key: 'ssh.dsh.port', value: 22230 },
  ])
  assert.deepEqual(swapped.changed.sort(), ['ssh.claude.port', 'ssh.dsh.port'])
  await flush()
  // 清掉一项：回到默认值，不再算“写过的”
  await write([
    { key: 'ssh.claude.port', value: null },
    { key: 'ssh.dsh.port', value: null },
  ])
  await flush()
  assert.equal(seen.view?.snapshot.values['ssh.claude.port'], 22230)
  assert.ok(!seen.view?.snapshot.explicit.includes('ssh.claude.port'))
})

test('对话里说“抢先改设置”：下一次保存得到冲突，什么都没写进去，并且拿到了最新的值', async () => {
  const { write, seen, flush, say } = await opened()
  const version = (seen.view as ManageView).snapshot.version
  await say('s3', '抢先改设置试试')
  await flush()
  assert.equal(seen.ops.length, 0, '别处的改动没有通知到这边')

  const failure = await failureOf(
    write([
      { key: 'ssh.pi.port', value: 22500 },
      { key: 'terminal.scrollback', value: 5000 },
    ]),
  )
  assert.equal(failure.code, 'conflict')
  assert.ok(failure.said?.['zh-CN'] && failure.said.en)
  await flush()
  const now = (seen.view as ManageView).snapshot
  assert.equal(now.version, version + 1, '只有别处的那一次')
  assert.equal(now.values['ssh.pi.port'], 22331, '别处改成的值，不是这边想写的')
  assert.equal(now.values['terminal.keepAlive'], 'day')
  assert.equal(now.values['terminal.scrollback'], 10000, '这边的一项都没落')
  assert.deepEqual(seen.ops.at(-1)?.keys.sort(), ['ssh.pi.port', 'terminal.keepAlive'])

  // 看过最新的值之后再保存：照常
  const retried = await write([{ key: 'terminal.scrollback', value: 5000 }])
  assert.deepEqual(retried.changed, ['terminal.scrollback'])
})

test('对话里说“别处改设置”：过一会儿这边收到通知，知道动的是哪两项', async () => {
  const { seen, flush, say } = await opened(10)
  await say('s4', '别处改设置看看')
  await flush()
  assert.equal(seen.ops.length, 0, '还没到时候')
  await flush(10 * 50)
  await flush()
  assert.deepEqual(seen.ops.at(-1)?.keys.sort(), ['ssh.dsh.port', 'terminal.keepAlive'])
  assert.equal(seen.view?.snapshot.values['ssh.dsh.port'], 22332)
  assert.equal(seen.view?.snapshot.values['terminal.keepAlive'], 'day')
})

test('对话里说“加一项设置”：订阅着的重新拿到结构，新的那一项看得到、改得了', async () => {
  const { seen, flush, say, write } = await opened()
  const key = 'harness.dsh.startupNote'
  assert.ok(!seen.view?.settings.some((entry) => entry.key === key))
  await say('s4', '加一项设置')
  await flush()
  assert.equal(seen.snapshots, 2)
  const added = seen.view?.settings.find((entry) => entry.key === key)
  assert.deepEqual([added?.type, added?.group], ['string', 'harness.dsh'])
  await write([{ key, value: '这次升级之后加的' }])
  await flush()
  assert.equal(seen.view?.snapshot.values[key], '这次升级之后加的')
  // 再说一遍不会再加一项
  await say('s4', '加一项设置')
  await flush()
  assert.equal(seen.view?.settings.filter((entry) => entry.key === key).length, 1)
})

test('重启一个空闲的 harness：先是“正在启动”，停稳了才应答；本来就起不来的，重启完还是起不来', async () => {
  const { channel, harness, flush } = await opened(10)
  let done: unknown = null
  void channel
    .command('device.harness.restart', { deviceId: 'local', harness: 'pi' })
    .then((result) => {
      done = result
    })
  await flush()
  assert.equal(harness('pi')?.state, 'unavailable')
  assert.deepEqual(harness('pi')?.reason, { key: 'harness.starting' })
  assert.equal(done, null, '还没停稳，不应答')
  await flush(10 * 20)
  await flush()
  assert.equal(harness('pi')?.state, 'ready')
  assert.deepEqual(done, { running: true, text: null })

  const codex = channel.command('device.harness.restart', { deviceId: 'local', harness: 'codex' })
  await flush(10 * 20)
  await flush()
  const result = await codex
  assert.equal(result.running, false)
  assert.ok(result.text?.['zh-CN'], '说得出为什么没起来')
  assert.equal(harness('codex')?.state, 'unavailable')
})

test('诊断、日志、ssh 配置片段：逐项的结果、读得到的末尾、只有起来了的入口才有配置', async () => {
  const { channel, flush } = await opened(10)
  const run = channel.command('device.diagnostics.run', { deviceId: 'local' })
  await flush(10 * 15)
  const diagnostics = await run
  assert.ok(diagnostics.ranAt)
  const statuses = new Set(diagnostics.checks.map((check) => check.status))
  assert.deepEqual([...statuses].sort(), ['failed', 'ok', 'skipped'])
  const only = channel.command('device.diagnostics.run', { deviceId: 'local', harness: 'pi' })
  await flush(10 * 15)
  assert.deepEqual(
    (await only).checks.map((check) => [check.id, check.status]),
    [
      ['runtime', 'ok'],
      ['terminal', 'ok'],
      ['sshEntry', 'failed'],
    ],
  )

  const device = await channel.command('device.logs.read', { deviceId: 'local', source: 'device' })
  assert.ok(device.text.includes('deviceSettings'))
  assert.equal(device.truncated, false)
  const runtime = await channel.command('device.logs.read', {
    deviceId: 'local',
    source: 'runtime',
    harness: 'pi',
  })
  assert.equal(runtime.truncated, true)
  assert.ok(runtime.path.endsWith('/pi/runtime.log'))
  // 没有这一份日志：文字是空的，不是错
  const none = await channel.command('device.logs.read', {
    deviceId: 'local',
    source: 'diagnostics',
    harness: 'pi',
  })
  assert.equal(none.text, '')

  const config = await channel.command('device.sshConfig.read', { deviceId: 'local' })
  const claude = config.entries.find((entry) => entry.harness === 'claude')
  assert.ok(claude?.config?.includes('Port 22230'))
  assert.ok(config.text.includes('Host codex-harness-adapter-claude'))
  const dsh = config.entries.find((entry) => entry.harness === 'dsh')
  assert.equal(dsh?.config, null)
  assert.ok(dsh?.unavailable?.en)
})
