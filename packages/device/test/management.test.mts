// 设备配置接口在设备进程这一侧：harness 的名单和状态照适配器主进程说的报，
// 设置的读写经控制通道转过去，重启之前先看有没有回合在跑。主进程由进程内的假控制通道扮演。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagedHarnessState } from '../../protocol/src/device-settings.mjs'
import { FakeControl, failure, managed } from './fake-control.mjs'
import { FakeUpstream, RpcFailure } from './fake-upstream.mjs'
import {
  assertErrorData,
  assertRuntimeInfo,
  assertSettingsChanged,
  assertSettingsErrorData,
  assertSettingsParams,
  assertSettingsResponse,
  assertStatusChanged,
  assertThreadList,
  errorCode,
  rig,
  settingsErrorCode,
  settle,
} from './helpers.mjs'

const STATUS = 'litch/harness/status/changed'
const CHANGED = 'litch/device/settings/changed'
const READ = 'litch/device/settings/read'
const WRITE = 'litch/device/settings/write'
const RESTART = 'litch/device/harness/restart'
/** 握手时两个扩展都声明 */
const BOTH = ['harness', 'deviceSettings']

/** 一台由主进程管着的设备：harness 的名单和状态由假控制通道给，运行时是假上游 */
function setup(states: Record<string, ManagedHarnessState>, announce = true) {
  const fakes: Record<string, FakeUpstream> = {}
  for (const id of Object.keys(states)) fakes[id] = new FakeUpstream(id)
  const control = new FakeControl(
    Object.entries(states).map(([id, state]) => managed(id, state)),
    announce,
  )
  const logs: string[] = []
  const device = rig(
    {},
    {},
    {
      control,
      dial: (socket) => (fakes[socket.slice('fake://'.length)] as FakeUpstream).connector,
      log: (line) => logs.push(line),
    },
  )
  return { ...device, control, fakes, logs }
}

const statusOf =
  (harness: string, kind: string | null) =>
  (frame: { method?: string; params?: unknown }): boolean => {
    const params = frame.params as any
    return (
      frame.method === STATUS &&
      params.harness === harness &&
      (params.info.unavailable?.kind ?? null) === kind
    )
  }

test('runtime/info 列出全部已知的 harness，没在跑的说明原因；两种语言的说明只给声明过的连接', async () => {
  const { connect, fakes, close } = setup({
    'claude-code': 'running',
    pi: 'disabled',
    dsh: 'notInstalled',
  })
  try {
    const client = connect()
    await client.initialize(BOTH)
    const info = await client.call('runtime/info')
    // 带着两种语言说明的应答，也和 harness 扩展的定义对得上
    assertRuntimeInfo(info)
    assert.ok(info.device.extensions.includes('deviceSettings'), '设备信息里列出了设置扩展')
    assert.deepEqual(
      info.harnesses.map((item: any) => [item.id, item.available, item.unavailable?.kind ?? null]),
      [
        ['claude-code', true, null],
        ['pi', false, 'disabled'],
        ['dsh', false, 'notInstalled'],
      ],
    )
    const pi = info.harnesses[1]
    assert.equal(pi.displayName, 'Pi', '没连上过的 harness 也有名字')
    assert.equal(pi.unavailable.message, '已在设置里停用')
    assert.deepEqual(pi.unavailable.text, {
      'zh-CN': '已在设置里停用',
      en: 'Turned off in settings',
    })
    assert.equal(fakes.pi?.connections.length, 0, '没在跑的运行时不去连')

    // 只声明了 harness 的连接：原因分类照给，两种语言的说明没有
    const plain = connect()
    await plain.initialize()
    const seen = await plain.call('runtime/info')
    assertRuntimeInfo(seen)
    assert.deepEqual(seen.harnesses[1].unavailable, { kind: 'disabled', message: '已在设置里停用' })

    // 合并的会话列表把这一次没列的都说出来，停用着的、没装的也在里面，原因分类和 runtime/info 用的是同一套词
    const list = await client.call('thread/list', {})
    assertThreadList(list)
    assert.deepEqual(list.skippedHarnesses, [
      { harness: 'pi', reason: 'unavailable', kind: 'disabled', message: '已在设置里停用' },
      {
        harness: 'dsh',
        reason: 'unavailable',
        kind: 'notInstalled',
        message: '没有找到它的命令行',
      },
    ])
    // 只问一个停用着的：一样说明，不是报错
    assert.deepEqual((await client.call('thread/list', { harness: 'pi' })).skippedHarnesses, [
      { harness: 'pi', reason: 'unavailable', kind: 'disabled', message: '已在设置里停用' },
    ])
  } finally {
    await close()
  }
})

test('没有控制通道：没有设置功能并说明原因，别的照旧', async () => {
  const { connect, close } = rig({ pi: new FakeUpstream('pi') })
  try {
    const client = connect()
    await client.initialize(BOTH)
    const info = await client.call('runtime/info')
    assert.ok(!info.device.extensions.includes('deviceSettings'))
    assert.deepEqual(
      info.harnesses.map((item: any) => [item.id, item.available]),
      [['pi', true]],
    )
    for (const method of [READ, WRITE, RESTART, 'litch/device/diagnostics/run']) {
      const error = await client.fails(method, { harness: 'pi', expectedVersion: 0, edits: [] })
      assert.equal(error.code, settingsErrorCode('settingsUnavailable'), method)
      assert.equal(error.data.litch, 'settingsUnavailable')
      assert.ok(error.data.text.en && error.message === error.data.text['zh-CN'])
      assertSettingsErrorData(error.data)
    }
  } finally {
    await close()
  }
})

test('停用和启用：状态变化有通知，转发出去的请求有交代，起来之后接着能用', async () => {
  const { connect, control, fakes, close } = setup({ 'claude-code': 'running', pi: 'running' })
  try {
    const client = connect()
    await client.initialize(BOTH)
    const plain = connect()
    await plain.initialize()
    const pi = fakes.pi as FakeUpstream
    const claude = fakes['claude-code'] as FakeUpstream
    // 设备先认识 Pi 的一个会话（列一次就记下了它属于谁）
    pi.threads.push({ id: 'p1', updatedAt: 10, cwd: '/' })
    assert.deepEqual(
      (await client.call('thread/list', {})).data.map((thread: any) => thread.id),
      ['p1'],
    )
    // 一个转发出去、对面迟迟不答的请求
    pi.handlers['slow/method'] = () => undefined
    const hanging = client.fails('slow/method', { harness: 'pi' })
    await settle()

    control.set('pi', 'disabled')
    const dropped = await hanging
    assert.equal(dropped.data.litch, 'harnessUnavailable')
    const off = await client.waitFor(statusOf('pi', 'disabled'))
    assertStatusChanged(off.params)
    assert.equal((off.params as any).info.unavailable.text.en, 'Turned off in settings')
    const offPlain = await plain.waitFor(statusOf('pi', 'disabled'))
    assertStatusChanged(offPlain.params)
    assert.equal(pi.live.length, 0, '到那个运行时的连接都断开了')
    const refused = await client.fails('model/list', { harness: 'pi' })
    assert.equal(refused.data.litch, 'harnessUnavailable')
    assert.match(refused.message, /已在设置里停用/)
    assertErrorData(refused.data)
    // 另一个 harness 不受影响
    assert.equal((await client.call('model/list', { harness: 'claude-code' })).data.length, 1)
    // 按父会话查：父会话属于停用着的那个，只说它这一次没列，不拿这个问题去问别的 harness
    const asked = claude.seen.length
    const children = await client.call('thread/list', { parentThreadId: 'p1' })
    assertThreadList(children)
    assert.deepEqual(
      [children.data, children.skippedHarnesses],
      [[], [{ harness: 'pi', reason: 'unavailable', kind: 'disabled', message: '已在设置里停用' }]],
    )
    assert.equal(claude.seen.length, asked, '没有去问另一个 harness')

    // 再启用：先是正在启动，起来之后恢复可用
    control.set('pi', 'starting')
    await client.waitFor(statusOf('pi', 'starting'))
    assert.equal(pi.live.length, 0, '还没起来的时候不去连')
    control.set('pi', 'running')
    const on = await client.waitFor(
      (frame) => statusOf('pi', null)(frame) && (frame.params as any).info.available === true,
    )
    assert.equal((on.params as any).info.unavailable, null)
    assert.equal((await client.call('model/list', { harness: 'pi' })).data[0].id, 'pi-model')
  } finally {
    await close()
  }
})

test('握手之后主进程才把名单送过来：补上，并通知客户端', async () => {
  const { connect, control, close } = setup({ pi: 'running', dsh: 'notInstalled' }, false)
  try {
    const client = connect()
    await client.initialize(BOTH)
    assert.deepEqual((await client.call('runtime/info')).harnesses, [])
    control.push()
    await client.waitFor((frame) => statusOf('pi', null)(frame))
    await client.waitFor(statusOf('dsh', 'notInstalled'))
    const info = await client.call('runtime/info')
    assert.deepEqual(
      info.harnesses.map((item: any) => [item.id, item.available]),
      [
        ['pi', true],
        ['dsh', false],
      ],
    )
  } finally {
    await close()
  }
})

test('写入：没有回合在跑的现在就重新应用，有回合在跑或者判断不了的留着待重启', async () => {
  const { connect, control, fakes, logs, close } = setup({
    'claude-code': 'running',
    pi: 'running',
  })
  try {
    const client = connect()
    await client.initialize(BOTH)
    assertSettingsResponse(READ, await client.call(READ))

    // 没有回合在跑：写入之后直接重新应用
    control.nextPending = ['pi']
    const params = {
      expectedVersion: 0,
      edits: [
        { key: 'harness.pi.env', value: [{ name: 'API_KEY', value: 'TOP-SECRET', secret: true }] },
      ],
    }
    assertSettingsParams(WRITE, params)
    const written = await client.call(WRITE, params)
    assertSettingsResponse(WRITE, written)
    assert.deepEqual(written.changed, ['harness.pi.env'])
    assert.deepEqual(written.restarted, ['pi'])
    assert.deepEqual(written.snapshot.pendingRestart, [])
    assert.equal(written.snapshot.version, 1)
    assert.deepEqual(control.sent('harness.apply'), [{ harness: 'pi' }])
    const changed = await client.waitFor((frame) => frame.method === CHANGED)
    assertSettingsChanged(changed.params)
    assert.deepEqual((changed.params as any).keys, ['harness.pi.env'])
    // 密钥只出现在写入请求里：不进日志，也不在发回来的任何一帧里
    assert.ok(!logs.join('\n').includes('TOP-SECRET'), '密钥没有进日志')
    assert.ok(!client.raw.join('\n').includes('TOP-SECRET'), '密钥没有被发回来')

    // 有回合在跑：写入成功，但不擅自重启
    const claude = fakes['claude-code'] as FakeUpstream
    claude.threads = [{ id: 'busy', updatedAt: 5, status: { type: 'active', activeFlags: [] } }]
    control.nextPending = ['claude-code']
    const held = await client.call(WRITE, {
      expectedVersion: 1,
      edits: [{ key: 'harness.claude-code.enabled', value: false }],
    })
    assert.deepEqual(held.restarted, [])
    assert.deepEqual(held.snapshot.pendingRestart, ['claude-code'])
    assert.equal(control.sent('harness.apply').length, 1, '有回合在跑时没有去重新应用')

    // 判断不了（运行时答不上来）：按有回合在跑处理
    ;(fakes.pi as FakeUpstream).handlers['thread/list'] = () => {
      throw new RpcFailure(-32603, 'boom')
    }
    control.nextPending = ['pi']
    const unsure = await client.call(WRITE, {
      expectedVersion: 2,
      edits: [{ key: 'harness.pi.cliPath', value: '/opt/pi' }],
    })
    assert.deepEqual(unsure.restarted, [])
    assert.deepEqual(unsure.snapshot.pendingRestart, ['claude-code', 'pi'])

    // 之前留着等用户重启的，不借别的写入去动它（哪怕它现在已经没有回合在跑了）
    claude.threads = []
    const later = await client.call(WRITE, {
      expectedVersion: 3,
      edits: [{ key: 'ssh.pi.port', value: 7400 }],
    })
    assert.deepEqual(later.restarted, [])
    assert.equal(control.sent('harness.apply').length, 1)
  } finally {
    await close()
  }
})

test('写入的应答就是定下来的样子：途中的状态不广播，应答之前只发一条定稿的通知', async () => {
  const { connect, control, fakes, close } = setup({ 'claude-code': 'running', pi: 'running' })
  const entry = (harness: string, state: 'idle' | 'listening') => ({
    harness,
    enabled: true,
    port: 7001,
    state,
    reason: null,
  })
  /** 这条连接收到的设置变化通知 */
  const notes = (client: { notifications: { method?: string; params?: unknown }[] }): any[] =>
    client.notifications.filter((frame) => frame.method === CHANGED).map((frame) => frame.params)
  try {
    const writer = connect()
    await writer.initialize(BOTH)
    const other = connect()
    await other.initialize(BOTH)
    control.patch({ sshEntries: [entry('pi', 'listening')] })
    await settle()
    const before = { writer: notes(writer).length, other: notes(other).length }

    // 主进程那一头照真的顺序来：写入先把 harness 标成待重启；重新应用时它停下又起来，
    // SSH 入口跟着没了又回来。每一步它都推一条 state
    const apply = control.handlers['harness.apply'] as (params: any) => unknown
    control.handlers['harness.apply'] = (params) => {
      control.set(params.harness, 'starting')
      control.patch({ sshEntries: [entry(params.harness, 'idle')] })
      const result = apply(params)
      control.patch({ sshEntries: [entry(params.harness, 'listening')] })
      return result
    }
    control.nextPending = ['pi']
    const written = await writer.call(WRITE, {
      expectedVersion: 0,
      edits: [{ key: 'harness.pi.env', value: [{ name: 'A', value: '1' }] }],
    })
    assertSettingsResponse(WRITE, written)
    assert.deepEqual(
      [written.restarted, written.snapshot.pendingRestart, written.snapshot.sshEntries[0].state],
      [['pi'], [], 'listening'],
    )
    // 重新应用一律等到有结果，不再有“不等结果”的说法
    assert.deepEqual(control.sent('harness.apply'), [{ harness: 'pi' }])
    await settle()
    // 待重启又摘掉、入口没了又回来的那几步没有发给客户端：两条连接各只收到一条
    for (const [client, had] of [
      [writer, before.writer],
      [other, before.other],
    ] as const) {
      const mine = notes(client).slice(had)
      assert.equal(mine.length, 1, '途中的几次变化并成了一条')
      assertSettingsChanged(mine[0])
      assert.deepEqual(mine[0].keys, ['harness.pi.env'])
      assert.deepEqual(mine[0].snapshot, written.snapshot, '通知里的和应答里的是同一份')
    }
    // 提出写入的那条连接上，通知排在应答前面
    const frames = writer.raw.map((text) => JSON.parse(text))
    const noticed = frames.findLastIndex((frame) => frame.method === CHANGED)
    const answered = frames.findLastIndex((frame) => frame.result?.restarted !== undefined)
    assert.ok(noticed >= 0 && noticed < answered, '定稿的通知先到，应答后到')
    // harness 自己的状态变化照常实时通知，不归这里管
    assert.ok(
      writer.notifications.some(
        (frame) =>
          frame.method === STATUS && (frame.params as any).info.unavailable?.kind === 'starting',
      ),
    )

    // 真的要等回合结束的：待重启留在定稿里，也只发一条
    const claude = fakes['claude-code'] as FakeUpstream
    claude.threads = [{ id: 'busy', updatedAt: 5, status: { type: 'active', activeFlags: [] } }]
    control.nextPending = ['claude-code']
    const count = notes(other).length
    const kept = await writer.call(WRITE, {
      expectedVersion: 1,
      edits: [{ key: 'harness.claude-code.cliPath', value: '/opt/claude' }],
    })
    await settle()
    assert.deepEqual([kept.restarted, kept.snapshot.pendingRestart], [[], ['claude-code']])
    assert.deepEqual(notes(other).slice(count), [
      { keys: ['harness.claude-code.cliPath'], snapshot: kept.snapshot },
    ])

    // 被拒的写入什么都没改：不发通知
    const quiet = notes(other).length
    await writer.fails(WRITE, { expectedVersion: 0, edits: [{ key: 'ssh.pi.port', value: 1 }] })
    await settle()
    assert.equal(notes(other).length, quiet)

    // 重新应用没做成：写入照样算成，待重启留着，通知和应答还是同一份
    control.handlers['harness.apply'] = () => {
      throw failure({ harness: 'pi' })
    }
    control.nextPending = ['pi']
    const stuck = await writer.call(WRITE, {
      expectedVersion: 2,
      edits: [{ key: 'harness.pi.cliPath', value: '/opt/pi' }],
    })
    await settle()
    assert.deepEqual([stuck.restarted, stuck.snapshot.pendingRestart], [[], ['claude-code', 'pi']])
    assert.deepEqual(notes(other).at(-1), {
      keys: ['harness.pi.cliPath'],
      snapshot: stuck.snapshot,
    })
  } finally {
    await close()
  }
})

test('重启：有回合在跑要明说照做；没在跑的不用问；不认识的 harness 被拒绝', async () => {
  const { connect, control, fakes, close } = setup({ 'claude-code': 'disabled', pi: 'running' })
  try {
    const client = connect()
    await client.initialize(BOTH)
    const pi = fakes.pi as FakeUpstream
    pi.threads = [{ id: 'busy', updatedAt: 5, status: { type: 'active', activeFlags: [] } }]
    const busy = await client.fails(RESTART, { harness: 'pi' })
    assert.equal(busy.code, settingsErrorCode('harnessBusy'))
    assert.equal(busy.data.harness, 'pi')
    assertSettingsErrorData(busy.data)
    assert.equal(control.sent('harness.apply').length, 0)

    assertSettingsParams(RESTART, { harness: 'pi', force: true })
    const forced = await client.call(RESTART, { harness: 'pi', force: true })
    assertSettingsResponse(RESTART, forced)
    assert.equal(forced.state, 'running')
    assert.deepEqual(control.sent('harness.apply'), [{ harness: 'pi' }])

    // 没在跑的 harness 没有回合可打断：直接照现行的设置再试一次
    const before = (fakes['claude-code'] as FakeUpstream).connections.length
    control.applyTo = 'startFailed'
    const retried = await client.call(RESTART, { harness: 'claude-code' })
    assertSettingsResponse(RESTART, retried)
    assert.equal(retried.state, 'startFailed')
    assert.ok(retried.text.en)
    assert.equal((fakes['claude-code'] as FakeUpstream).connections.length, before, '没有去探测')

    const unknown = await client.fails(RESTART, { harness: 'codex' })
    assert.equal(unknown.code, errorCode('unknownHarness'))
    assert.equal(unknown.data.litch, 'unknownHarness')
  } finally {
    await close()
  }
})

test('写入被拒：版本号对不上带回最新的快照，值不合规矩指出是哪个键', async () => {
  const { connect, control, close } = setup({ pi: 'running' })
  try {
    const client = connect()
    await client.initialize(BOTH)
    const stale = await client.fails(WRITE, {
      expectedVersion: 7,
      edits: [{ key: 'harness.pi.enabled', value: false }],
    })
    assert.equal(stale.code, settingsErrorCode('settingsConflict'))
    assert.equal(stale.data.litch, 'settingsConflict')
    assert.equal(stale.data.snapshot.version, 0, '带回了现行的快照')
    assertSettingsErrorData(stale.data)

    control.handlers['settings.write'] = () => {
      throw failure({
        reason: 'invalid',
        key: 'ssh.pi.port',
        text: { 'zh-CN': '端口要在 1 到 65535 之间', en: 'The port must be between 1 and 65535' },
      })
    }
    const invalid = await client.fails(WRITE, {
      expectedVersion: 0,
      edits: [{ key: 'ssh.pi.port', value: 99999 }],
    })
    assert.equal(invalid.code, settingsErrorCode('invalidSetting'))
    assert.equal(invalid.data.key, 'ssh.pi.port')
    assert.equal(invalid.message, '端口要在 1 到 65535 之间')
    assert.equal(invalid.data.text.en, 'The port must be between 1 and 65535')
    assertSettingsErrorData(invalid.data)

    // 参数本身就不成形的，不用去问主进程
    const before = control.requests.length
    const shapeless = await client.fails(WRITE, { edits: 'nope' })
    assert.equal(shapeless.data.litch, 'invalidSetting')
    assert.equal(control.requests.length, before)

    // 主进程那边做不成的动作
    control.handlers['diagnostics.run'] = () => {
      throw failure({ reason: 'failed', harness: 'pi' })
    }
    const failed = await client.fails('litch/device/diagnostics/run', { harness: 'pi' })
    assert.equal(failed.code, settingsErrorCode('deviceActionFailed'))
    assert.equal(failed.data.harness, 'pi')
    assertSettingsErrorData(failed.data)

    // 这个前缀下没有的方法
    const missing = await client.fails('litch/device/nope', {})
    assert.equal(missing.code, errorCode('unsupported'))
  } finally {
    await close()
  }
})

test('设置变化的通知只发给声明过 deviceSettings 的连接；只是 harness 状态变了不发', async () => {
  const { connect, control, close } = setup({ pi: 'running' })
  try {
    const declared = connect()
    await declared.initialize(BOTH)
    const plain = connect()
    await plain.initialize()
    const quiet = connect()
    await quiet.initialize(BOTH, { optOutNotificationMethods: [CHANGED] })

    // 只是 harness 的状态变了：有状态变化的通知，没有设置变化的通知
    control.set('pi', 'starting')
    await declared.waitFor(statusOf('pi', 'starting'))
    control.set('pi', 'running')
    await declared.waitFor(
      (frame) => statusOf('pi', null)(frame) && (frame.params as any).info.available === true,
    )
    assert.ok(!declared.notifications.some((frame) => frame.method === CHANGED))

    // SSH 入口的状况变了（没有哪个键被改）：快照不一样了，照样通知
    control.patch({
      sshEntries: [{ harness: 'pi', enabled: true, port: 7391, state: 'listening', reason: null }],
    })
    const entry = await declared.waitFor((frame) => frame.method === CHANGED)
    assertSettingsChanged(entry.params)
    assert.deepEqual((entry.params as any).keys, [])
    assert.equal((entry.params as any).snapshot.sshEntries[0].state, 'listening')

    // 别的连接写了设置：每条声明过的连接都收到
    await plain.call(WRITE, {
      expectedVersion: 0,
      edits: [{ key: 'ssh.pi.enabled', value: false }],
    })
    const written = await declared.waitFor(
      (frame) => frame.method === CHANGED && (frame.params as any).keys.length > 0,
    )
    assert.deepEqual((written.params as any).keys, ['ssh.pi.enabled'])
    assert.equal((written.params as any).snapshot.version, 1)
    await settle()
    assert.ok(!plain.notifications.some((frame) => frame.method === CHANGED), '没声明的收不到')
    assert.ok(!quiet.notifications.some((frame) => frame.method === CHANGED), '退订了的收不到')
  } finally {
    await close()
  }
})

test('诊断、日志、ssh 配置片段：原样交给主进程，结果原样带回', async () => {
  const { connect, control, close } = setup({ 'claude-code': 'running', pi: 'disabled' })
  try {
    // 客户端主动调用的方法不要求声明扩展
    const client = connect()
    await client.initialize()

    const all = await client.call('litch/device/diagnostics/run')
    assertSettingsResponse('litch/device/diagnostics/run', all)
    assert.equal(all.checks[0].status, 'ok')
    assertSettingsParams('litch/device/diagnostics/run', { harness: 'pi' })
    await client.call('litch/device/diagnostics/run', { harness: 'pi' })
    assert.deepEqual(control.sent('diagnostics.run'), [{}, { harness: 'pi' }])

    const params = { source: 'runtime', harness: 'pi', maxBytes: 2048 }
    assertSettingsParams('litch/device/logs/read', params)
    const log = await client.call('litch/device/logs/read', params)
    assertSettingsResponse('litch/device/logs/read', log)
    assert.equal(log.path, '/fake/runtime.log')
    assert.deepEqual(control.sent('logs.tail'), [params])

    control.handlers['ssh.config'] = () => ({
      entries: [
        {
          harness: 'claude-code',
          alias: 'cha-claude',
          port: 7391,
          config: 'Host cha-claude\n  Port 7391\n',
          unavailable: null,
        },
        {
          harness: 'pi',
          alias: 'cha-pi',
          port: 7392,
          config: null,
          unavailable: { 'zh-CN': '这个入口关着', en: 'This entry is off' },
        },
      ],
      text: 'Host cha-claude\n  Port 7391\n',
    })
    const ssh = await client.call('litch/device/sshConfig/read')
    assertSettingsResponse('litch/device/sshConfig/read', ssh)
    assert.equal(ssh.entries.length, 2)
    assert.match(ssh.text, /Host cha-claude/)
  } finally {
    await close()
  }
})
