// 原生 codex 作为聚合面上的又一个 harness：状态、握手、声明、合并列表、路由、通知。
// 审批、“不支持”的错误、权限预设的映射、导入它的项目在 native-codex-requests.test.mts。
// 对面是假的原生 codex（fake-codex.mts）；对着真的 codex 的检查是 scripts/check-native-codex.mjs。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagedHarnessState } from '../../protocol/src/device-settings.mjs'
import { codexRig, sentTo, statusOf } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import {
  assertDeclaration,
  assertErrorData,
  assertRuntimeInfo,
  assertStatusChanged,
  assertThreadList,
  settle,
} from './helpers.mjs'

const BOTH = ['harness', 'deviceSettings']

test('原生 codex 没在跑的几种状态：照主进程说的报，不去连它；名字和徽标认得出', async () => {
  const cases: [ManagedHarnessState, RegExp][] = [
    ['disabled', /停用/],
    ['notInstalled', /没有找到/],
    ['versionTooLow', /版本太低/],
  ]
  for (const [state, reason] of cases) {
    const env = codexRig({ codex: state })
    try {
      const client = env.connect()
      await client.initialize(BOTH)
      const info = await client.call('runtime/info')
      assertRuntimeInfo(info)
      const codex = info.harnesses.find((item: any) => item.id === 'codex')
      assert.deepEqual(
        [codex.displayName, codex.badge, codex.available, codex.version, codex.unavailable.kind],
        ['Codex', 'CX', false, null, state],
      )
      assert.match(codex.unavailable.message, reason)
      assert.ok(codex.unavailable.text.en)
      // 没连上过就没有声明
      assert.equal(codex.features, undefined)
      assert.equal(env.codex.connections.length, 0, '没在跑的时候不该去连它')
      // 另一个 harness 照常
      assert.equal((await client.call('model/list', { harness: 'pi' })).data[0].id, 'pi-model')
      const refused = await client.fails('thread/start', { harness: 'codex' })
      assert.equal(refused.data.litch, 'harnessUnavailable')
      assertErrorData(refused.data)
      // 列表里没有它的会话，并且说了这一次没列它、为什么（和 runtime/info 里说的一样）
      const list = await client.call('thread/list', { limit: 10 })
      assert.deepEqual(
        list.data.map((thread: any) => thread.harness),
        ['pi', 'pi'],
      )
      assert.deepEqual(list.skippedHarnesses, [
        {
          harness: 'codex',
          reason: 'unavailable',
          kind: state,
          message: codex.unavailable.message,
        },
      ])
    } finally {
      await env.close()
    }
  }
})

test('握手：我们的扩展键和退订名单不带给原生 codex，别的照客户端给的带；不问它 runtime/info', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'deviceSettings', 'declineWithNote'], {
      optOutNotificationMethods: ['thread/tokenUsage/updated'],
    })
    const greeting = env.codex.greetings[0]
    assert.deepEqual(greeting, {
      clientInfo: { name: 'device-test', title: null, version: '0.0.1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    assert.ok(!env.codex.seen.some((entry) => entry.method === 'runtime/info'))
    assert.deepEqual(
      env.codex.seen.map((entry) => entry.method),
      ['initialize', 'initialized', 'permissionProfile/list'],
    )
    // 适配器的运行时照旧收到扩展键；退订名单两种上游都不带
    const toPi = sentTo(env.pi, 'initialize')[0]
    assert.deepEqual(toPi.capabilities.litchExtensions, [
      'harness',
      'deviceSettings',
      'declineWithNote',
    ])
    assert.equal(toPi.capabilities.optOutNotificationMethods, undefined)
  } finally {
    await env.close()
  }
})

test('声明：设备进程替原生 codex 整理，形状和引擎自己报的那份定义一致', async () => {
  const fake = new FakeCodex()
  fake.cliVersion = '0.162.0-alpha.20'
  const env = codexRig({ fake })
  try {
    const client = env.connect()
    // 客户端的名字里有像版本号的东西：不能被当成 codex 的版本
    await client.call('initialize', {
      clientInfo: { name: 'litch-9.9.9', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: true, litchExtensions: ['harness'] },
    })
    const info = await client.call('runtime/info')
    assertRuntimeInfo(info)
    const codex = info.harnesses.find((item: any) => item.id === 'codex')
    assert.deepEqual(
      {
        id: codex.id,
        displayName: codex.displayName,
        badge: codex.badge,
        version: codex.version,
        engine: codex.engine,
        available: codex.available,
        unavailable: codex.unavailable,
        extensions: codex.extensions,
      },
      {
        id: 'codex',
        displayName: 'Codex',
        badge: 'CX',
        version: '0.162.0-alpha.20',
        engine: 'codex',
        available: true,
        unavailable: null,
        // 它不认识我们的任何扩展，没有“拒绝时附说明”；客户端工具是设备进程替它挑执行方，所以报
        extensions: ['clientTools'],
      },
    )
    assertDeclaration(codex)
    assert.deepEqual(codex.features.revert, {
      byTurnId: true,
      byCount: false,
      restoresFiles: false,
    })
    assert.deepEqual(codex.features.approvals, {
      kinds: ['command', 'fileChange', 'permissions'],
      uncovered: [],
    })
    assert.equal(codex.features.agentMessagePhase, 'onStart')
    assert.equal(codex.features.planUpdates, false)
    assert.deepEqual(
      codex.permissionPresets.map((preset: any) => [
        preset.id,
        preset.risk,
        preset.requiresConfirmation,
        preset.switchInSession,
        preset.switchDuringTurn,
      ]),
      [
        [':read-only', 'low', false, true, false],
        [':workspace', 'medium', false, true, false],
        [':danger-full-access', 'high', true, true, false],
      ],
    )
    for (const preset of codex.permissionPresets)
      assert.ok(preset.title.en && preset.description['zh-CN'] && preset.description.en)
  } finally {
    await env.close()
  }
})

test('权限预设：这个 codex 不许选的档不报；问不到权限档时三档都报', async () => {
  const restricted = new FakeCodex()
  restricted.profiles = restricted.profiles.map((profile) =>
    profile.id === ':danger-full-access' ? { ...profile, allowed: false } : profile,
  )
  const old = new FakeCodex()
  delete old.handlers['permissionProfile/list']
  const expectations: [FakeCodex, string[]][] = [
    [restricted, [':read-only', ':workspace']],
    [old, [':read-only', ':workspace', ':danger-full-access']],
  ]
  for (const [fake, expected] of expectations) {
    const env = codexRig({ fake })
    try {
      const client = env.connect()
      await client.initialize()
      const info = await client.call('runtime/info')
      const codex = info.harnesses.find((item: any) => item.id === 'codex')
      assert.equal(codex.available, true)
      assert.deepEqual(
        codex.permissionPresets.map((preset: any) => preset.id),
        expected,
      )
    } finally {
      await env.close()
    }
  }
})

test('会话列表：原生 codex 的会话和别的 harness 的并在一起，打上 harness，记进索引', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize()
    const list = await client.call('thread/list', { limit: 10 })
    assertThreadList(list)
    const [first, second] = [codexThread(1, 400), codexThread(2, 200)]
    assert.deepEqual(
      list.data.map((thread: any) => [thread.id, thread.harness]),
      [
        [first.id, 'codex'],
        ['p1', 'pi'],
        [second.id, 'codex'],
        ['p2', 'pi'],
      ],
    )
    // 它那边的字段原样带着
    assert.equal(list.data[0].modelProvider, 'openai')
    assert.equal(list.data[0].cliVersion, '0.160.0')
    // 给它的参数是聚合面定的那几个，没有我们自己的
    assert.deepEqual(sentTo(env.codex, 'thread/list')[0], {
      limit: 10,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    })
    // 只要它的
    const only = await client.call('thread/list', { limit: 10, harness: 'codex' })
    assert.deepEqual(
      only.data.map((thread: any) => thread.id),
      [first.id, second.id],
    )
    // 索引里记着了：按会话走的请求直接到它，不用再问一遍
    const before = env.codex.seen.length
    await client.call('turn/start', { threadId: first.id, input: [] })
    assert.deepEqual(
      env.codex.seen.slice(before).map((entry) => entry.method),
      ['turn/start'],
    )
    assert.ok(!env.pi.seen.some((entry) => entry.method === 'turn/start'))
  } finally {
    await env.close()
  }
})

test('路由：带 harness 参数的到原生 codex 并摘掉这个参数；不认识的会话问一遍，它不认的标识不算它的', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize()
    const started = await client.call('thread/start', { harness: 'codex', cwd: '/work/new' })
    assert.equal(started.thread.harness, 'codex')
    assert.deepEqual(sentTo(env.codex, 'thread/start'), [{ cwd: '/work/new' }])
    assert.equal(sentTo(env.pi, 'thread/start').length, 0)
    assert.equal((await client.call('model/list', { harness: 'codex' })).data.length, 1)
    assert.deepEqual(sentTo(env.codex, 'model/list'), [{}])
    // 新建出来的会话记着是它的
    await client.call('turn/start', { threadId: started.thread.id, input: [] })
    assert.equal(sentTo(env.codex, 'turn/start').at(-1).threadId, started.thread.id)

    // 没见过的会话：两边都问。Pi 的会话标识不是 codex 那种写法，它回“标识无效”，不算它的
    await client.call('turn/start', { threadId: 'p2', input: [] })
    assert.equal(sentTo(env.pi, 'turn/start').at(-1).threadId, 'p2')
    assert.deepEqual(sentTo(env.codex, 'thread/read').at(-1), {
      threadId: 'p2',
      includeTurns: false,
    })
    // 没见过的 codex 会话（比如刚在终端里开的）：问到是它的
    const fresh = codexThread(9, 900)
    env.codex.threads.push(fresh)
    const read = await client.call('thread/read', { threadId: fresh.id, includeTurns: false })
    assert.equal(read.thread.harness, 'codex')
  } finally {
    await env.close()
  }
})

test('通知：原生 codex 发的，带会话标识的原样转发，不带的加上 harness；会话开始的通知打标', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize()
    const threadId = codexThread(1, 400).id
    // 仓库里固定的协议类型里没有的方法和字段照样透传，不因为版本对不上就丢掉
    const future = `{"method":"thread/prediction/updated","params":{"threadId":"${threadId}","prediction":{"kind":"new"}},"unknownTopLevel":true}`
    env.codex.live[0]?.send(null, future)
    await client.waitFor((frame) => frame.method === 'thread/prediction/updated')
    assert.equal(client.raw.at(-1), future)

    env.codex.notify('account/rateLimits/updated', { rateLimits: { primary: null } })
    const limits = await client.waitFor((frame) => frame.method === 'account/rateLimits/updated')
    assert.deepEqual(limits.params, { rateLimits: { primary: null }, harness: 'codex' })

    const born = codexThread(7, 700)
    env.codex.threads.push(born)
    env.codex.notify('thread/started', { thread: born })
    const started = await client.waitFor((frame) => frame.method === 'thread/started')
    assert.equal((started.params as any).thread.harness, 'codex')
  } finally {
    await env.close()
  }
})

test('运行中在设置里关掉再打开：连接断开并说明原因，起来之后重新握手，声明还在', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(BOTH)
    assert.equal(env.codex.live.length, 1)
    // 一个转发出去、它迟迟不答的请求
    env.codex.handlers['slow/method'] = () => undefined
    const hanging = client.fails('slow/method', { harness: 'codex' })
    await settle()

    env.control.set('codex', 'disabled')
    assert.equal((await hanging).data.litch, 'harnessUnavailable')
    const off = await client.waitFor(statusOf('codex', 'disabled'))
    assertStatusChanged(off.params)
    assert.equal(env.codex.live.length, 0, '到它的连接断开了')
    const refused = await client.fails('model/list', { harness: 'codex' })
    assert.equal(refused.data.litch, 'harnessUnavailable')
    assert.equal((await client.call('model/list', { harness: 'pi' })).data[0].id, 'pi-model')

    env.control.set('codex', 'starting')
    await client.waitFor(statusOf('codex', 'starting'))
    assert.equal(env.codex.live.length, 0, '还没起来的时候不去连')
    env.control.set('codex', 'running')
    const on = await client.waitFor(
      (frame) => statusOf('codex', null)(frame) && (frame.params as any).info.available === true,
    )
    assertStatusChanged(on.params)
    const info = (on.params as any).info
    assert.equal(info.version, '0.160.0')
    assertDeclaration(info)
    // 重新握手时还是不带我们的扩展键
    assert.equal(env.codex.greetings.length, 2)
    assert.equal(env.codex.greetings[1].capabilities.litchExtensions, undefined)
    assert.equal((await client.call('model/list', { harness: 'codex' })).data.length, 1)
  } finally {
    await env.close()
  }
})
