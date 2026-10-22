// 设备与 harness 管理：核心对着假的聚合面（fake-device.mts）和假的设备配置接口（fake-settings.mts）跑。
// 守的是这几条：读写、冲突不悄悄覆盖、通知、密钥到不了界面、对面没有这个接口时的表现。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DeviceSettingsSnapshot, Thread } from '../../protocol/src/index.mjs'
import {
  type AppOp,
  type AppView,
  type ChannelError,
  createCore,
  type DeviceSnapshot,
  type DeviceView,
  type ManageOp,
  type ManageView,
  type SidebarOp,
  type SidebarView,
} from '../src/index.mjs'
import { type FakeHarness, fakeDevice, harness, infoOf } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeSettings, spec } from './fake-settings.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { setup as single } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

const pair = (): FakeHarness[] => [
  harness('pi', {
    displayName: 'Pi',
    badge: 'PI',
    threads: [thread({ id: 'p1', updatedAt: 1_700_000_400 })],
  }),
  harness('cc', {
    displayName: 'Claude Code',
    badge: 'CC',
    threads: [thread({ id: 'c1', updatedAt: 1_700_000_300 })],
  }),
]

/** 一个假设备，可以有几个客户端（各是一个真的核心）连上去 */
function world(extensions: string[] = ['harness', 'deviceSettings'], harnesses = pair()) {
  const fake = fakeDevice(harnesses)
  fake.device.extensions = extensions
  const { settings, handlers } = fakeSettings()
  const peer = fakeOpener({ ...fake.handlers, ...handlers })
  const time = fakeClock()

  /** 一个客户端：核心，加上像界面那样把订阅到的东西落下来 */
  const client = (remembered: DeviceSnapshot | null = null) => {
    const logs: string[] = []
    const saved: DeviceSnapshot[] = []
    const core = createCore({
      clock: time.clock,
      version: '9.9.9',
      log: (line) => logs.push(line),
      store: {
        load: () => ({ localWire: null, remotes: [] }),
        save() {},
        snapshot: () => ({
          load: () => remembered,
          save: (snapshot) => saved.push(structuredClone(snapshot)),
        }),
        forget() {},
      },
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
    const rows = new Map<string, string>()
    core.subscribe(
      { kind: 'sidebar', deviceId: 'local' },
      {
        snapshot(data) {
          rows.clear()
          for (const entry of (data as SidebarView).sessions) rows.set(entry.id, entry.harness)
        },
        delta(ops) {
          for (const op of ops as SidebarOp[]) {
            if (op.op === 'session.upsert') rows.set(op.session.id, op.session.harness)
            else if (op.op === 'session.remove') rows.delete(op.sessionId)
          }
        },
        error() {},
      },
    )
    const device = (): DeviceView | undefined => {
      const last = app.ops.findLast((op) => op.op === 'device.upsert')
      return last?.op === 'device.upsert' ? last.device : app.first?.devices[0]
    }
    /** 订阅管理数据，像界面那样把快照和增量落下来。一切给界面的东西都留在 seen 里 */
    const watch = () => {
      const seen = {
        view: null as ManageView | null,
        snapshots: 0,
        ops: [] as ManageOp[],
        errors: [] as ChannelError[],
      }
      const close = core.subscribe(
        { kind: 'manage', deviceId: 'local' },
        {
          snapshot(data) {
            seen.view = structuredClone(data as ManageView)
            seen.snapshots++
          },
          delta(ops) {
            for (const op of ops as ManageOp[]) {
              seen.ops.push(structuredClone(op))
              if (seen.view) seen.view.snapshot = structuredClone(op.snapshot)
            }
          },
          error: (error) => seen.errors.push(error),
        },
      )
      return { seen, close }
    }
    const command = (name: string, params: object = {}) =>
      core.command(name, { deviceId: 'local', ...params }, never)
    return { core, logs, saved, device, rows, watch, command }
  }

  /** 像设备服务那样，把设置现在的样子广播给每一条连接 */
  const broadcast = (keys: string[], patch: Partial<DeviceSettingsSnapshot> = {}) => {
    settings.snapshot = { ...settings.snapshot, ...patch }
    for (const server of peer.servers) {
      server.notify('litch/device/settings/changed', { keys, snapshot: settings.snapshot })
    }
  }
  /** 对面收到过的某个方法的参数，按到达顺序，几条连接的都算 */
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  return { fake: fake.device, settings, peer, time, client, broadcast, sent }
}

/** 一条命令没做成时的错误 */
async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

/** 一个客户端连上并订阅好管理数据 */
async function opened(extensions?: string[]) {
  const w = world(extensions)
  const me = w.client()
  me.core.start()
  await settle()
  const { seen, close } = me.watch()
  await settle()
  return { ...w, me, seen, close }
}

test('握手时声明认识 deviceSettings；设备信息里列了它，这台设备才算能管理', async () => {
  const { me, peer } = await opened()
  const init = peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(init.capabilities.litchExtensions.includes('deviceSettings'))
  assert.equal(me.device()?.manageable, true)
})

test('对面没有设置接口：设备不算能管理，订阅和命令都以 unsupported 结束，不去调那些方法', async () => {
  // 旧版的设备服务：是聚合面，但扩展里没有 deviceSettings
  const w = world(['harness'])
  const me = w.client()
  me.core.start()
  await settle()
  assert.equal(me.device()?.mode, 'full')
  assert.equal(me.device()?.manageable, false)
  assert.throws(() => me.watch(), { code: 'unsupported' })
  const failure = await failureOf(
    me.command('device.settings.write', { expectedVersion: 0, edits: [] }),
  )
  assert.equal(failure.code, 'unsupported')
  assert.equal((await failureOf(me.command('device.diagnostics.run'))).code, 'unsupported')
  assert.deepEqual(
    w.peer.last().seen.filter((entry) => entry.method.startsWith('litch/device/')),
    [],
  )

  // 单 harness 模式（原生 codex，或者适配器的单个入口）也一样
  const lone = single()
  lone.core.start()
  await settle()
  const views: DeviceView[] = []
  lone.core.subscribe(
    { kind: 'app' },
    { snapshot: (data) => views.push(...(data as AppView).devices), delta() {}, error() {} },
  )
  assert.equal(views[0]?.mode, 'single')
  assert.equal(views[0]?.manageable, false)
  assert.throws(
    () =>
      lone.core.subscribe(
        { kind: 'manage', deviceId: 'local' },
        { snapshot() {}, delta() {}, error() {} },
      ),
    { code: 'unsupported' },
  )
})

test('订阅：读一次，拿到设备服务声明的结构和现在的值；第二个订阅者不再读', async () => {
  const { me, seen, settings } = await opened()
  assert.equal(settings.reads, 1)
  const view = seen.view as ManageView
  assert.deepEqual(
    view.groups.map((group) => [group.id, group.scope.kind]),
    [
      ['harness.pi', 'harness'],
      ['ssh', 'device'],
    ],
  )
  assert.deepEqual(
    view.settings.map((entry) => [entry.key, entry.type, entry.restart]),
    [
      ['harness.pi.enabled', 'boolean', 'harness'],
      ['harness.pi.env', 'env', 'harness'],
      ['harness.pi.apiKey', 'secret', 'harness'],
      ['ssh.pi.enabled', 'boolean', 'none'],
      ['ssh.pi.port', 'integer', 'none'],
    ],
  )
  // 哪一项是 harness 的启用开关，是设备服务标出来的；别的开关（入口的那个）没有标
  assert.deepEqual(
    view.settings.map((entry) => entry.role),
    ['enable', null, null, null, null],
  )
  const port = view.settings.find((entry) => entry.key === 'ssh.pi.port')
  assert.deepEqual([port?.minimum, port?.maximum, port?.default], [1, 65535, 2200])
  // 给人看的字两种语言都带着，核心不挑
  assert.deepEqual(port?.title, { 'zh-CN': 'ssh.pi.port 的标题', en: 'Title of ssh.pi.port' })
  assert.equal(view.snapshot.version, 3)
  assert.equal(view.snapshot.values['ssh.pi.port'], 2200)
  assert.deepEqual(view.snapshot.sshEntries, [
    { harness: 'pi', enabled: false, port: 2200, state: 'off', reason: null },
  ])

  const second = me.watch()
  await settle()
  assert.equal(second.seen.snapshots, 1, '第二个订阅者当场拿到手上那一份')
  assert.equal(settings.reads, 1)
})

test('已保存的密钥到不了界面：对面就算把值给过来了，快照、增量、日志、存盘的东西里都没有', async () => {
  const w = world()
  // 对面出了岔子：该遮的都没遮
  w.settings.snapshot = {
    ...w.settings.snapshot,
    values: {
      ...w.settings.snapshot.values,
      'harness.pi.apiKey': 'sk-LEAK-secret-type' as never,
      'harness.pi.env': [
        { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
        { name: 'PI_API_KEY', value: 'sk-LEAK-marked', secret: true },
        // 没标成密钥，但名字一看就是
        { name: 'UPSTREAM_TOKEN', value: 'sk-LEAK-by-name' },
      ],
    },
  }
  w.settings.inheritedEnv = [
    { name: 'NO_PROXY', value: 'localhost', secret: false },
    { name: 'OPENAI_API_KEY', value: 'sk-LEAK-inherited', secret: true },
  ]
  const me = w.client()
  me.core.start()
  await settle()
  const { seen } = me.watch()
  await settle()
  const view = seen.view as ManageView
  assert.deepEqual(view.snapshot.values['harness.pi.apiKey'], { set: true })
  assert.deepEqual(view.snapshot.values['harness.pi.env'], [
    { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
    { name: 'PI_API_KEY', secret: true },
    { name: 'UPSTREAM_TOKEN', secret: true },
  ])
  assert.deepEqual(view.inheritedEnv, [
    { name: 'NO_PROXY', value: 'localhost', secret: false },
    { name: 'OPENAI_API_KEY', secret: true },
  ])

  // 通知里带来的、自己写入之后对面给回来的，也一样
  w.broadcast(['harness.pi.env'], {
    version: 4,
    values: {
      ...w.settings.snapshot.values,
      'harness.pi.env': [{ name: 'PI_API_KEY', value: 'sk-LEAK-notified', secret: true }],
    },
  })
  await settle()
  await me.command('device.settings.write', {
    expectedVersion: 4,
    edits: [
      { key: 'harness.pi.apiKey', value: 'sk-NEW-typed-by-user' },
      { key: 'harness.pi.env', value: [{ name: 'PI_API_KEY', value: 'sk-NEW-env', secret: true }] },
    ],
  })
  await settle()
  w.time.advance(5000)
  const everything = JSON.stringify([seen, me.device(), me.logs, me.saved])
  assert.ok(!everything.includes('sk-LEAK'), '对面漏过来的密钥到了界面这一侧')
  assert.ok(!everything.includes('sk-NEW'), '用户刚填的密钥被留在了给界面的数据或日志里')
  // 新填的密钥确实发给了对面，只发了这一次
  assert.equal(JSON.stringify(w.sent('litch/device/settings/write')).split('sk-NEW').length - 1, 2)
})

test('写入：改动原样发给对面，带着界面看到的版本号；新的值经增量到，结果里说哪些重启了、哪些还等着', async () => {
  const { me, seen, settings, sent } = await opened()
  settings.restartOnWrite = ['pi']
  const result = await me.command('device.settings.write', {
    expectedVersion: 3,
    edits: [
      { key: 'ssh.pi.port', value: 2300 },
      // 环境变量表整张写：密钥不带值就是保留原来的
      {
        key: 'harness.pi.env',
        value: [
          { name: 'HTTPS_PROXY', value: 'http://10.0.0.1:1' },
          { name: 'PI_API_KEY', secret: true },
        ],
      },
      { key: 'harness.pi.enabled', value: null },
    ],
  })
  assert.deepEqual(result, {
    changed: ['ssh.pi.port', 'harness.pi.env', 'harness.pi.enabled'],
    restarted: ['pi'],
    pendingRestart: [],
  })
  assert.deepEqual(sent('litch/device/settings/write'), [
    {
      expectedVersion: 3,
      edits: [
        { key: 'ssh.pi.port', value: 2300 },
        {
          key: 'harness.pi.env',
          value: [
            { name: 'HTTPS_PROXY', value: 'http://10.0.0.1:1' },
            { name: 'PI_API_KEY', secret: true },
          ],
        },
        { key: 'harness.pi.enabled', value: null },
      ],
    },
  ])
  assert.equal(seen.ops.length, 1)
  assert.equal(seen.view?.snapshot.version, 4)
  assert.equal(seen.view?.snapshot.values['ssh.pi.port'], 2300)
  assert.deepEqual(seen.ops[0]?.keys.toSorted(), [
    'harness.pi.enabled',
    'harness.pi.env',
    'ssh.pi.port',
  ])
})

test('两个客户端先后改同一项：后写的得到冲突，什么都没覆盖，并且看到了最新的值', async () => {
  const w = world()
  const first = w.client()
  const second = w.client()
  first.core.start()
  second.core.start()
  await settle()
  const mine = second.watch()
  first.watch()
  await settle()
  assert.equal(mine.seen.view?.snapshot.version, 3)

  // 第一个先写成了。通知还没到第二个那里（没有广播），它手上还是旧的版本号
  await first.command('device.settings.write', {
    expectedVersion: 3,
    edits: [{ key: 'ssh.pi.port', value: 2301 }],
  })
  const failure = await failureOf(
    second.command('device.settings.write', {
      expectedVersion: 3,
      edits: [{ key: 'ssh.pi.port', value: 2399 }],
    }),
  )
  assert.equal(failure.code, 'conflict')
  // 设备服务的说明两种语言都带着，界面按当前语言说
  assert.deepEqual(failure.said, { 'zh-CN': '设置已经被别处改过了', en: 'EN 设置已经被别处改过了' })
  assert.equal(w.settings.snapshot.values['ssh.pi.port'], 2301, '后写的没有把先写的盖掉')
  assert.equal(w.sent('litch/device/settings/write').length, 2, '冲突之后没有自己再写一遍')
  // 第二个客户端的界面上已经是最新的值，并且知道是哪一项被动过
  await settle()
  assert.equal(mine.seen.view?.snapshot.version, 4)
  assert.equal(mine.seen.view?.snapshot.values['ssh.pi.port'], 2301)
  assert.deepEqual(mine.seen.ops.at(-1)?.keys, ['ssh.pi.port'])

  // 用户看过最新的值之后再写，就成了
  await second.command('device.settings.write', {
    expectedVersion: 4,
    edits: [{ key: 'ssh.pi.port', value: 2399 }],
  })
  assert.equal(w.settings.snapshot.values['ssh.pi.port'], 2399)
})

test('哪一项的值不合规矩：以 invalid 结束，说得出是哪一项，原因两种语言都有', async () => {
  const { me, seen, settings } = await opened()
  const failure = await failureOf(
    me.command('device.settings.write', {
      expectedVersion: 3,
      edits: [{ key: 'no.such.key', value: 1 }],
    }),
  )
  assert.equal(failure.code, 'invalid')
  assert.equal(failure.key, 'no.such.key')
  assert.deepEqual(failure.said, { 'zh-CN': '没有这一项', en: 'EN 没有这一项' })
  assert.equal(settings.snapshot.version, 3)
  assert.equal(seen.ops.length, 0)
})

test('别处改了设置：通知一到，界面的值跟着变，并且知道动的是哪几项；过期的通知不要', async () => {
  const { seen, broadcast, settings } = await opened()
  broadcast(['ssh.pi.enabled'], {
    version: 4,
    values: { ...settings.snapshot.values, 'ssh.pi.enabled': true },
    sshEntries: [{ harness: 'pi', enabled: true, port: 2200, state: 'listening', reason: null }],
  })
  await settle()
  assert.equal(seen.view?.snapshot.values['ssh.pi.enabled'], true)
  assert.equal(seen.view?.snapshot.sshEntries[0]?.state, 'listening')
  assert.deepEqual(seen.ops.at(-1)?.keys, ['ssh.pi.enabled'])

  // 只是待重启的名单、入口的状况变了：键是空的，值照样换
  broadcast([], {
    pendingRestart: ['pi'],
    sshEntries: [
      {
        harness: 'pi',
        enabled: true,
        port: 2200,
        state: 'failed',
        reason: {
          kind: 'portUnavailable',
          text: { 'zh-CN': '端口被占', en: 'Port in use' },
          detail: 'bind: address already in use',
        },
      },
    ],
  })
  await settle()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, ['pi'])
  assert.deepEqual(seen.view?.snapshot.sshEntries[0]?.reason, {
    kind: 'portUnavailable',
    text: { 'zh-CN': '端口被占', en: 'Port in use' },
    detail: 'bind: address already in use',
  })
  assert.deepEqual(seen.ops.at(-1)?.keys, [])

  // 一模一样的再来一遍：不打扰界面
  const before = seen.ops.length
  broadcast([])
  await settle()
  assert.equal(seen.ops.length, before)

  // 比手上这份还旧的：丢掉
  const latest = settings.snapshot
  broadcast(['ssh.pi.port'], { version: 2, values: { ...latest.values, 'ssh.pi.port': 1 } })
  await settle()
  assert.equal(seen.view?.snapshot.version, 4)
  assert.equal(seen.view?.snapshot.values['ssh.pi.port'], 2200)
})

test('自己写入的途中到的通知先攒着：harness 被标成待重启又摘掉的那一下，界面看不到', async () => {
  const w = await opened()
  const { me, seen, settings } = w
  // 照设备服务的顺序：先广播“写进去了，pi 待重启”，再去重启它，再广播“摘掉了”，最后才应答
  settings.restartOnWrite = ['pi']
  settings.beforeWriteReply = () => {
    w.broadcast(['harness.pi.enabled'], { pendingRestart: ['pi'] })
    w.broadcast([], { pendingRestart: [] })
  }
  const result = await me.command('device.settings.write', {
    expectedVersion: 3,
    edits: [{ key: 'harness.pi.enabled', value: false }],
  })
  await settle()
  assert.deepEqual(result, {
    changed: ['harness.pi.enabled'],
    restarted: ['pi'],
    pendingRestart: [],
  })
  assert.deepEqual(
    seen.ops.map((op) => [op.snapshot.version, op.snapshot.pendingRestart, op.keys]),
    [[4, [], ['harness.pi.enabled']]],
    '界面只看到写完之后的那一份',
  )
  assert.equal(seen.view?.snapshot.values['harness.pi.enabled'], false)

  // 写入之后才到的通知照常用
  settings.beforeWriteReply = null
  w.broadcast([], { pendingRestart: ['pi'] })
  await settle()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, ['pi'])
})

test('写入的应答里入口还是中间的样子，同一个版本号的通知里才是最后的：界面停在最后的那个上', async () => {
  const w = await opened()
  const { me, seen, settings } = w
  // 照设备服务的做法：应答里的快照是写完那一下的（入口还没起来），入口起来之后再广播一条，版本号不变。
  // 两条挨得很近，客户端可能在同一拍里收到，这时候通知还攒着
  settings.beforeWriteReply = () => {
    const listening = {
      ...settings.snapshot,
      sshEntries: [{ harness: 'pi', enabled: true, port: 2200, state: 'listening', reason: null }],
    }
    settings.snapshot = {
      ...settings.snapshot,
      sshEntries: [{ harness: 'pi', enabled: true, port: 2200, state: 'idle', reason: null }],
    }
    for (const server of w.peer.servers) {
      server.notify('litch/device/settings/changed', {
        keys: ['ssh.pi.enabled'],
        snapshot: settings.snapshot,
      })
      server.notify('litch/device/settings/changed', { keys: [], snapshot: listening })
    }
  }
  await me.command('device.settings.write', {
    expectedVersion: 3,
    edits: [{ key: 'ssh.pi.enabled', value: true }],
  })
  await settle()
  assert.equal(seen.view?.snapshot.version, 4)
  assert.equal(seen.view?.snapshot.values['ssh.pi.enabled'], true)
  assert.deepEqual(
    seen.view?.snapshot.sshEntries.map((entry) => [entry.harness, entry.state]),
    [['pi', 'listening']],
    '入口最后的状况没有丢',
  )
})

test('设备服务新加的设置项、这一版不认识的类型：不改核心也到得了界面，改得了', async () => {
  const w = world()
  w.settings.schema.settings.push(
    // 核心的代码里哪儿都没有这两个键
    spec('harness.pi.brandNewKnob', 'string', {
      scope: { kind: 'harness', harness: 'pi' },
      default: 'factory',
    }),
    spec('experimental.matrix', 'matrix', { default: { rows: 2 } as never }),
    spec('experimental.window', 'duration', { default: '30s', role: 'headline' as never }),
  )
  w.settings.snapshot.values['harness.pi.brandNewKnob'] = 'tuned'
  w.settings.snapshot.values['experimental.matrix'] = { rows: 9, token: 'sk-LEAK-nested' } as never
  w.settings.snapshot.values['experimental.window'] = '45s'
  const me = w.client()
  me.core.start()
  await settle()
  const { seen } = me.watch()
  await settle()
  const view = seen.view as ManageView
  const knob = view.settings.find((entry) => entry.key === 'harness.pi.brandNewKnob')
  assert.deepEqual(
    [knob?.type, knob?.default, knob?.scope],
    ['string', 'factory', { kind: 'harness', harness: 'pi' }],
  )
  assert.equal(view.snapshot.values['harness.pi.brandNewKnob'], 'tuned')
  // 不认识的类型：类型的名字照给，界面自己兜底。简单的值照给，别的不知道里面有什么，不往界面上放
  assert.equal(view.settings.find((entry) => entry.key === 'experimental.matrix')?.type, 'matrix')
  // 没标角色的、标了这一版不认识的角色的，都当作没标
  assert.deepEqual([knob?.role, view.settings.at(-1)?.role], [null, null])
  assert.equal(view.snapshot.values['experimental.matrix'], null)
  assert.equal(view.snapshot.values['experimental.window'], '45s')
  assert.ok(!JSON.stringify(seen).includes('sk-LEAK'))

  await me.command('device.settings.write', {
    expectedVersion: 3,
    edits: [{ key: 'harness.pi.brandNewKnob', value: 'retuned' }],
  })
  assert.equal(w.settings.snapshot.values['harness.pi.brandNewKnob'], 'retuned')
  await settle()
  assert.equal(seen.view?.snapshot.values['harness.pi.brandNewKnob'], 'retuned')
})

test('重启 harness：它有回合在跑时以 busy 结束、什么都没做；说了照做才带着 force 去', async () => {
  const { me, seen, settings, broadcast, sent } = await opened()
  broadcast([], { pendingRestart: ['pi'] })
  settings.busy.add('pi')
  await settle()
  const failure = await failureOf(me.command('device.harness.restart', { harness: 'pi' }))
  assert.equal(failure.code, 'busy')
  assert.deepEqual(failure.said, { 'zh-CN': 'pi 有回合在跑', en: 'EN pi 有回合在跑' })
  assert.deepEqual(sent('litch/device/harness/restart'), [{ harness: 'pi' }])
  assert.deepEqual(seen.view?.snapshot.pendingRestart, ['pi'], '没重启成，还等着')

  const result = await me.command('device.harness.restart', { harness: 'pi', force: true })
  assert.deepEqual(result, { running: true, text: null })
  assert.deepEqual(sent('litch/device/harness/restart').at(-1), { harness: 'pi', force: true })
  await settle()
  assert.deepEqual(seen.view?.snapshot.pendingRestart, [], '应答里带回来的值已经用上')
})

test('诊断、日志末尾、ssh 配置片段：都换成给界面的形状', async () => {
  const { me, sent } = await opened()
  assert.deepEqual(await me.command('device.diagnostics.run', { harness: 'pi' }), {
    ranAt: Date.parse('2026-10-13T08:00:00Z'),
    checks: [
      {
        id: 'runtime',
        scope: { kind: 'harness', harness: 'pi' },
        status: 'failed',
        title: { 'zh-CN': '引擎的命令行', en: 'Engine CLI' },
        detail: { 'zh-CN': '没找到', en: 'Not found' },
        logPath: '/state/pi/diagnostics.log',
      },
    ],
  })
  assert.deepEqual(sent('litch/device/diagnostics/run'), [{ harness: 'pi' }])
  assert.deepEqual(
    await me.command('device.logs.read', { source: 'runtime', harness: 'pi', maxBytes: 2048 }),
    {
      path: '/state/logs/pi/runtime.log',
      text: '一行日志\n',
      truncated: true,
      size: 4096,
      directory: '/state/logs',
    },
  )
  assert.deepEqual(sent('litch/device/logs/read'), [
    { source: 'runtime', harness: 'pi', maxBytes: 2048 },
  ])
  assert.deepEqual(await me.command('device.sshConfig.read'), {
    entries: [
      {
        harness: 'pi',
        alias: 'codex-harness-adapter-pi',
        port: 2200,
        config: null,
        unavailable: { 'zh-CN': '这个入口关着', en: 'This entry is off' },
      },
    ],
    text: '',
  })
})

test('任务卡按 harness 的开关：有人看着设置时设备的显示数据里带上，跟着通知变；没人看、没有这一项是 null，不另外去读', async () => {
  const w = world()
  w.settings.schema.settings.push(
    spec('harness.pi.taskCards', 'boolean', {
      scope: { kind: 'harness', harness: 'pi' },
      default: true,
    }),
  )
  w.settings.snapshot.values['harness.pi.taskCards'] = false
  const me = w.client()
  me.core.start()
  await settle()
  assert.equal(w.settings.reads, 0)
  assert.equal(me.device()?.tools.harnesses?.pi?.taskCards, null)
  const { close } = me.watch()
  await settle()
  assert.equal(w.settings.reads, 1)
  assert.equal(me.device()?.tools.harnesses?.pi?.taskCards, false)
  // 设备服务没声明这一项的 harness（旧版）
  assert.equal(me.device()?.tools.harnesses?.cc?.taskCards, null)
  w.broadcast(['harness.pi.taskCards'], {
    version: 4,
    values: { ...w.settings.snapshot.values, 'harness.pi.taskCards': true },
  })
  await settle()
  assert.equal(me.device()?.tools.harnesses?.pi?.taskCards, true)
  close()
  await settle()
  assert.equal(me.device()?.tools.harnesses?.pi?.taskCards, null)
})

test('订阅的时候设备还没连上：连上才有快照；断了再连上，重新读一份', async () => {
  const w = world()
  const me = w.client()
  const { seen } = me.watch()
  assert.equal(seen.snapshots, 0)
  me.core.start()
  await settle()
  assert.equal(seen.snapshots, 1)
  assert.equal(w.settings.reads, 1)

  // 断开的那一阵里别处改了设置：这边没有通知可收，连回来之后读到的就是新的
  w.peer.last().drop()
  await settle()
  w.settings.snapshot = {
    ...w.settings.snapshot,
    version: 9,
    values: { ...w.settings.snapshot.values, 'ssh.pi.port': 2500 },
  }
  w.time.advance(1000)
  await settle()
  assert.equal(w.settings.reads, 2)
  assert.equal(seen.snapshots, 2)
  assert.equal(seen.view?.snapshot.values['ssh.pi.port'], 2500)
  assert.equal(seen.errors.length, 0)
})

test('没人看着管理数据的时候不留着：关掉再打开，重新读，不拿旧的充数', async () => {
  const { me, close, settings, broadcast } = await opened()
  close()
  // 没人订阅时到的通知不处理
  broadcast(['ssh.pi.port'], {
    version: 4,
    values: { ...settings.snapshot.values, 'ssh.pi.port': 2600 },
  })
  await settle()
  const again = me.watch()
  await settle()
  assert.equal(settings.reads, 2)
  assert.equal(again.seen.view?.snapshot.values['ssh.pi.port'], 2600)
})

test('不可用原因的两种语言版本：设备服务给了就带给界面，由界面按语言挑', async () => {
  const harnesses = pair()
  const cc = harnesses[1] as FakeHarness
  cc.down = { kind: 'notInstalled', message: '没有找到命令行' }
  const w = world(undefined, harnesses)
  // 声明过 deviceSettings 的连接收得到 text
  const info = () => ({
    ...infoOf(cc),
    unavailable: { ...cc.down, text: { 'zh-CN': '没有找到命令行', en: 'CLI not found' } },
  })
  const me = w.client()
  me.core.start()
  await settle()
  w.peer.last().notify('litch/harness/status/changed', { harness: 'cc', info: info() })
  await settle()
  const view = me.device()?.harnesses.find((entry) => entry.id === 'cc')
  assert.deepEqual(view?.reason, { key: 'harness.notInstalled' })
  assert.deepEqual(view?.detail, { 'zh-CN': '没有找到命令行', en: 'CLI not found' })
})

test('停用一个 harness：它的会话留在侧栏里；之后再对一次账也还在，哪怕列表没说跳过了它', async () => {
  const w = world()
  const me = w.client()
  me.core.start()
  await settle()
  assert.deepEqual([...me.rows.keys()].sort(), ['c1', 'p1'])

  // 在设置里停用了 pi：设备服务停掉它的运行时，报它不可用
  const pi = w.fake.harnesses[0] as FakeHarness
  const kept: Thread[] = pi.threads
  pi.down = { kind: 'disabled', message: '已在设置里停用' }
  w.peer.last().notify('litch/harness/status/changed', { harness: 'pi', info: infoOf(pi) })
  await settle()
  assert.equal(me.device()?.harnesses.find((entry) => entry.id === 'pi')?.state, 'disabled')
  assert.deepEqual([...me.rows.keys()].sort(), ['c1', 'p1'], '已有的会话还看得到')

  // 真的设备进程对停用了的 harness 连都不去连，合并的列表里既没有它的会话，也不说跳过了它
  w.fake.harnesses = w.fake.harnesses.filter((entry) => entry !== pi)
  await me.command('device.refresh')
  assert.deepEqual([...me.rows.keys()].sort(), ['c1', 'p1'], '对过账之后它的会话还在')
  assert.equal(me.rows.get('p1'), 'pi')

  // 再启用：它回来了，会话照旧
  pi.down = null
  pi.threads = kept
  w.fake.harnesses = [pi, ...w.fake.harnesses]
  w.peer.last().notify('litch/harness/status/changed', { harness: 'pi', info: infoOf(pi) })
  await settle()
  assert.equal(me.device()?.harnesses.find((entry) => entry.id === 'pi')?.state, 'ready')
  assert.deepEqual([...me.rows.keys()].sort(), ['c1', 'p1'])
})
