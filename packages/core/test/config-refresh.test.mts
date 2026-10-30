// 配置补齐：用模拟设备和独立界面桥核对读写、输入校验与授权边界，不访问本机配置。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConfigBridge } from '../src/config/bridge.mjs'
import { createConfigExecutor } from '../src/config/executor.mjs'
import { createMockCore } from '../src/mock/mock-core.mjs'
import type { ConfigMainRequest, ConfigTopicOp, ConfigTopicView } from '../src/model-config.mjs'
import { fakeClock, settle } from './helpers.mjs'

function fixture() {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, lang: 'en' })
  const bridge = createConfigBridge(time.clock)
  const mains: ConfigMainRequest[] = []
  const state = { enabled: false, allowedDevices: [] as string[] }
  const executor = createConfigExecutor({
    core,
    clock: time.clock,
    version: 'test',
    lang: () => 'en',
    bridge,
    main: async (request) => {
      mains.push(request)
      if (request.kind === 'chrome.enable') state.enabled = request.enabled
      if (request.kind === 'chrome.device')
        state.allowedDevices = request.enabled ? [request.deviceId] : []
      return { ok: true, data: { ...state } }
    },
  })
  const run = async (argv: string[]) => {
    const reply = await executor.run(
      { argv, json: true, lang: 'en' },
      { threadId: null, harness: null, hold: () => () => {} },
    )
    const first = reply.contentItems[0]
    assert.ok(first?.type === 'inputText')
    return JSON.parse(first.text) as { ok: boolean; data: any; error?: string }
  }
  const pump = async <T,>(pending: Promise<T>): Promise<T> => {
    let done = false
    void pending.finally(() => {
      done = true
    })
    for (let i = 0; i < 100 && !done; i++) {
      time.advance(50)
      await settle()
    }
    assert.ok(done, '命令应在隔离时钟内结束')
    return pending
  }
  return { time, core, bridge, mains, state, run, pump }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await settle()
}

test('桌面偏好：只读查询、发送方式和手册开关交给窗口，拒绝非法值', async () => {
  const f = fixture()
  const box: { view: ConfigTopicView | null } = { view: null }
  const close = f.bridge.subscribe({
    snapshot: (view) => {
      box.view = view as ConfigTopicView
    },
    delta(ops) {
      for (const op of ops as ConfigTopicOp[]) box.view = op.view
    },
    error() {},
  })
  // 通过同一界面桥答复查询。
  for (const [argv, expected, data] of [
    [
      ['notify', 'get'],
      { kind: 'prefs.get' },
      { notifyScope: 'main', notifySessions: true, notifySuccess: false },
    ],
    [['look', 'get'], { kind: 'prefs.get' }, { skin: 'human', sendMode: 'queue' }],
    [['chat', 'get'], { kind: 'prefs.get' }, { sendMode: 'queue' }],
    [
      ['chat', 'send-mode', 'now'],
      { kind: 'prefs.set', patch: { sendMode: 'now' } },
      { sendMode: 'now' },
    ],
    [['assist', 'get'], { kind: 'manual.get' }, { enabled: true, targets: [] }],
    [
      ['assist', 'manual', 'off'],
      { kind: 'manual.set', enabled: false },
      { enabled: false, targets: [] },
    ],
    [
      ['open', 'settings/chrome'],
      { kind: 'open', place: { where: 'settings', section: 'chrome' } },
      null,
    ],
    [['open', 'managers'], { kind: 'open', place: { where: 'managers' } }, null],
    [['open', 'suggestions'], { kind: 'open', place: { where: 'suggestions' } }, null],
  ] as const) {
    const pending = f.run([...argv])
    await flush()
    const ask = box.view?.asks[0]
    assert.deepEqual(ask?.request, expected)
    assert.ok(ask)
    f.bridge.reply(ask.id, true, data, null)
    assert.equal((await pending).ok, true)
  }
  assert.equal((await f.run(['chat', 'send-mode', 'later'])).ok, false)
  assert.equal((await f.run(['assist', 'manual', 'maybe'])).ok, false)
  assert.equal(box.view?.asks.length, 0)
  close()
})

test('Chrome：读取不确认；开启必须确认，拒绝不写；关闭不用确认', async () => {
  const f = fixture()
  const box: { view: ConfigTopicView | null } = { view: null }
  const close = f.bridge.subscribe({
    snapshot: (view) => {
      box.view = view as ConfigTopicView
    },
    delta(ops) {
      for (const op of ops as ConfigTopicOp[]) box.view = op.view
    },
    error() {},
  })
  assert.equal((await f.run(['chrome', 'get'])).data.enabled, false)
  for (const allow of [false, true]) {
    const pending = f.run(['chrome', 'set', 'on'])
    await flush()
    const card = box.view?.confirms[0]
    assert.ok(card)
    assert.deepEqual(card.items, [{ kind: 'chrome', device: null }])
    assert.equal(f.mains.filter((item) => item.kind === 'chrome.enable').length, 0)
    f.bridge.answer(card.id, allow)
    assert.equal((await pending).ok, allow)
  }
  assert.equal(f.state.enabled, true)
  assert.equal((await f.run(['chrome', 'set', 'off'])).data.enabled, false)
  assert.equal((await f.run(['chrome', 'set', 'on', '--device', 'local'])).ok, false)
  const pending = f.run(['chrome', 'set', 'on', '--device', 'build'])
  await flush()
  const card = box.view?.confirms[0]
  assert.ok(card)
  assert.equal(card.items[0]?.kind, 'chrome')
  f.bridge.answer(card.id, true)
  assert.equal((await pending).ok, true)
  assert.deepEqual(f.state.allowedDevices, ['build'])
  close()
  assert.equal((await f.run(['chrome', 'set', 'on'])).ok, false)
})

test('经理：新建、读回、局部修改保留其他设置，非法参数和已结束经理不写', async () => {
  const f = fixture()
  const run = (argv: string[]) => f.pump(f.run(argv))
  const box: { view: ConfigTopicView | null } = { view: null }
  const close = f.bridge.subscribe({
    snapshot: (view) => {
      box.view = view as ConfigTopicView
    },
    delta: (ops) => {
      for (const op of ops as ConfigTopicOp[]) box.view = op.view
    },
    error() {},
  })
  const guarded = async (argv: string[], allow: boolean, during?: () => Promise<void>) => {
    const pending = f.run(argv)
    await flush()
    const card = box.view?.confirms[0]
    assert.ok(card)
    assert.equal(card.items[0]?.kind, 'manager')
    if (during) await during()
    f.bridge.answer(card.id, allow)
    return { card, result: await f.pump(pending) }
  }
  assert.equal((await run(['managers', 'list', 'local'])).ok, true)
  const create = [
    'managers',
    'create',
    'local',
    '--cwd',
    '/work/litch',
    '--harness',
    'pi',
    '--rules',
    '只整理事实',
    '--notify',
    'off',
  ]
  const count = (await run(['managers', 'list', 'local'])).data.length
  const declined = await guarded(create, false)
  assert.equal(declined.result.ok, false)
  assert.equal((await run(['managers', 'list', 'local'])).data.length, count)
  const { result: made, card } = await guarded(create, true)
  assert.deepEqual(card.items[0], {
    kind: 'manager',
    action: 'create',
    name: '',
    rules: '只整理事实',
    device: 'This computer',
    cwd: '/work/litch',
    harness: 'Pi',
    lineHarness: 'Pi',
    maxRunning: 4,
    worktree: false,
    merge: 'manager',
    firstTask: false,
  })
  assert.equal(made.ok, true, made.error ?? '')
  const id = made.data.manager.id as string
  const before = await run(['managers', 'get', 'local', id])
  assert.equal(before.data.rules, '只整理事实')
  assert.equal(before.data.dispatch.maxRunningLines, 4)
  assert.equal(before.data.contact.desktopNotification, false)
  const changed = await run([
    'managers',
    'set',
    'local',
    id,
    '--max-running',
    '2',
    '--worktree',
    'on',
  ])
  assert.equal(changed.ok, true, changed.error ?? '')
  assert.equal(changed.data.rules, '只整理事实')
  assert.equal(changed.data.dispatch.maxRunningLines, 2)
  assert.equal(changed.data.dispatch.worktree, true)
  assert.equal(changed.data.contact.desktopNotification, false)
  const read = await run(['managers', 'get', 'local', id])
  assert.deepEqual(read.data.dispatch, changed.data.dispatch)
  for (const args of [
    ['--max-running', '0'],
    ['--max-running', '1.5'],
    ['--merge', 'auto'],
    ['--notify', 'maybe'],
    [],
  ]) {
    assert.equal((await run(['managers', 'set', 'local', id, ...args])).ok, false)
  }
  assert.equal((await run(['managers', 'create', 'local', '--harness', 'pi'])).ok, false)
  const ended = (await run(['managers', 'list', 'local'])).data.find(
    (item: { status: string }) => item.status === 'ended',
  )
  assert.ok(ended)
  assert.equal((await run(['managers', 'set', 'local', ended.id, '--notify', 'on'])).ok, false)
  for (const args of [
    ['--max-running', '8'],
    ['--line-harness', 'claude'],
    ['--worktree', 'off'],
  ]) {
    assert.equal((await guarded(['managers', 'set', 'local', id, ...args], false)).result.ok, false)
    assert.deepEqual(
      (await run(['managers', 'get', 'local', id])).data.dispatch,
      changed.data.dispatch,
    )
  }
  // 降低权限直接执行；把合并责任再交给经理需确认。
  assert.equal((await run(['managers', 'set', 'local', id, '--merge', 'user'])).ok, true)
  assert.equal(
    (await guarded(['managers', 'set', 'local', id, '--merge', 'manager'], false)).result.ok,
    false,
  )
  assert.equal((await run(['managers', 'get', 'local', id])).data.dispatch.merge, 'user')
  assert.equal(
    (await guarded(['managers', 'set', 'local', id, '--max-running', '8'], true)).result.ok,
    true,
  )
  assert.equal((await run(['managers', 'get', 'local', id])).data.dispatch.maxRunningLines, 8)
  // 确认期间别人修改了设置，不拿旧快照覆盖它。
  const conflict = await guarded(
    ['managers', 'set', 'local', id, '--max-running', '9'],
    true,
    async () => {
      assert.equal((await run(['managers', 'set', 'local', id, '--name', '另一窗口改名'])).ok, true)
    },
  )
  assert.equal(conflict.result.ok, false)
  assert.match(conflict.result.error ?? '', /changed during confirmation/)
  close()
  assert.equal((await run(create)).ok, false, '没有窗口不能创建经理')
})

test('建议留存：手册中的普通枚举值可读写，JSON 引号不当作值的一部分', async () => {
  const f = fixture()
  const run = (argv: string[]) => f.pump(f.run(argv))
  const key = 'sessions.suggestionRetentionDays'
  for (const value of ['14', 'never']) {
    assert.equal((await run(['settings', 'set', 'local', `${key}=${value}`])).ok, true)
    const read = await run(['settings', 'get', 'local', key])
    assert.equal(read.data.settings[0].value, value)
  }
  assert.equal((await run(['settings', 'set', 'local', `${key}="14"`])).ok, false)
})

test('Codex 自动起名：等待配置就绪，按版本写入，再读回；非法值不写', async () => {
  const f = fixture()
  const run = (argv: string[]) => f.pump(f.run(argv))
  const first = await run(['harness', 'auto-title', 'build'])
  assert.ok(first.ok, first.error ?? '')
  assert.equal(first.data.enabled, true)
  assert.equal((await run(['harness', 'auto-title', 'build', 'off'])).data.enabled, false)
  assert.equal((await run(['harness', 'auto-title', 'build'])).data.enabled, false)
  assert.equal((await run(['harness', 'auto-title', 'build', 'maybe'])).ok, false)
})
