// litch config 的执行器（14 号设计 3.3–3.5）：拆参数、帮助、操作清单和 config-ops.mts 一一对上、
// 代表性的读写、要界面做的事（交给最近订阅的窗口、窗口回话）、放宽安全的确认卡（允许、拒绝、两分钟没人理、没有窗口）。
// 执行器对着模拟核心跑（和真的核心走同一套命令和主题）；接线（握手声明、命令行调用的路由）对着真的核心和假设备。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import { CONFIG_OPS, configOpName } from '../../protocol/src/config-ops.mjs'
import type { JsonRpcMessage } from '../../protocol/src/index.mjs'
import { parseHead, parseRest, splitWords } from '../src/config/argv.mjs'
import { CONFIRM_TIMEOUT_MS } from '../src/config/bridge.mjs'
import { CONFIG_HANDLERS } from '../src/config/executor.mjs'
import { helpText } from '../src/config/help.mjs'
import { originOf } from '../src/config/ops-app.mjs'
import {
  type AppView,
  type ConfigTopicOp,
  type ConfigTopicView,
  createCore,
  createMockCore,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

// ---------- 拆参数 ----------

test('拆参数：组和动作、帮助的几种写法、--json 不算参数、认不出的组和动作', () => {
  assert.deepEqual(parseHead([]), { kind: 'help', group: null })
  assert.deepEqual(parseHead(['help']), { kind: 'help', group: null })
  assert.deepEqual(parseHead(['--help']), { kind: 'help', group: null })
  assert.deepEqual(parseHead(['help', 'tasks']), { kind: 'help', group: 'tasks' })
  assert.deepEqual(parseHead(['devices', '--help']), { kind: 'help', group: 'devices' })
  assert.deepEqual(parseHead(['devices', 'add', '-h']), { kind: 'help', group: 'devices' })
  assert.deepEqual(parseHead(['status', '--json']), {
    kind: 'op',
    group: 'status',
    action: '',
    rest: [],
  })
  assert.deepEqual(parseHead(['open', 'device', 'local']), {
    kind: 'op',
    group: 'open',
    action: '',
    rest: ['device', 'local'],
  })
  assert.deepEqual(parseHead(['update', 'check']), {
    kind: 'problem',
    problem: { kind: 'group', group: 'update' },
  })
  assert.deepEqual(parseHead(['harness', 'install', 'local', 'claude']), {
    kind: 'problem',
    problem: { kind: 'action', group: 'harness', action: 'install' },
  })
  assert.deepEqual(parseHead(['devices']), {
    kind: 'problem',
    problem: { kind: 'action', group: 'devices', action: null },
  })
})

test('拆参数：带值的选项（空格和等号两种）、开关、-- 之后都是位置参数、个数不对、不认识的选项', () => {
  const spec = { args: [1, 2] as const, options: ['name', 'wire'], flags: ['force'] }
  const head = { group: 'devices', action: 'add', rest: [] as string[] }
  const ok = parseRest(
    { ...head, rest: ['box', '--name', 'Dev Box', '--wire=blue', '--force'] },
    spec,
  )
  assert.ok(ok.ok)
  assert.deepEqual(ok.command.positionals, ['box'])
  assert.deepEqual(
    [...ok.command.options],
    [
      ['name', 'Dev Box'],
      ['wire', 'blue'],
    ],
  )
  assert.deepEqual([...ok.command.flags], ['force'])
  const dashed = parseRest({ ...head, rest: ['a', '--', '--odd'] }, spec)
  assert.ok(dashed.ok)
  assert.deepEqual(dashed.command.positionals, ['a', '--odd'])
  assert.deepEqual(parseRest({ ...head, rest: [] }, spec), {
    ok: false,
    problem: { kind: 'count', min: 1, max: 2, got: 0 },
  })
  assert.deepEqual(parseRest({ ...head, rest: ['a', '--color', 'x'] }, spec), {
    ok: false,
    problem: { kind: 'option', name: 'color', known: ['--name', '--wire', '--force'] },
  })
  assert.deepEqual(parseRest({ ...head, rest: ['a', '--name'] }, spec), {
    ok: false,
    problem: { kind: 'value', name: 'name' },
  })
  assert.deepEqual(parseRest({ ...head, rest: ['a', '--force=yes'] }, spec), {
    ok: false,
    problem: { kind: 'value', name: 'force' },
  })
})

test('拆一行命令：引号、转义、空白', () => {
  assert.deepEqual(splitWords(`devices rename box "Dev  Box" 'it''s' a\\ b`), [
    'devices',
    'rename',
    'box',
    'Dev  Box',
    'its',
    'a b',
  ])
  assert.deepEqual(splitWords('  '), [])
  assert.deepEqual(splitWords(`settings set local 'x='`), ['settings', 'set', 'local', 'x='])
})

test('网站写法认成来源', () => {
  assert.equal(originOf('github.com/openai'), 'https://github.com')
  assert.equal(originOf('HTTP://Example.com:80/x'), 'http://example.com')
  assert.equal(originOf('https://a.test:8443'), 'https://a.test:8443')
  assert.equal(originOf('ftp://x.com'), null)
  assert.equal(originOf('not a site'), null)
})

// ---------- 操作清单 ----------

test('操作清单：执行器实现的和 config-ops.mts 一一对上，多一个少一个都不行', () => {
  const declared = CONFIG_OPS.map((op) => configOpName(op)).sort()
  const implemented = Object.keys(CONFIG_HANDLERS).sort()
  assert.deepEqual(implemented, declared)
  // 应用更新、装 harness、打开系统设置都不归 litch config 管
  for (const gone of [
    'update status',
    'harness install',
    'harness versions',
    'computer open-settings',
  ]) {
    assert.equal(CONFIG_HANDLERS[gone], undefined, gone)
  }
})

test('帮助：中英两份都列出每个操作的用法；一组的帮助带一句话说明', () => {
  for (const lang of ['zh-CN', 'en'] as const) {
    const all = helpText(lang, null, CONFIG_HANDLERS)
    for (const op of CONFIG_OPS) {
      if (op.group === 'help') continue
      const spec = CONFIG_HANDLERS[configOpName(op)]
      assert.ok(spec && all.includes(spec.usage), `${lang} 缺 ${configOpName(op)}`)
    }
    const tasks = helpText(lang, 'tasks', CONFIG_HANDLERS)
    assert.ok(tasks.includes(lang === 'zh-CN' ? '暂停' : 'Pause'))
    assert.ok(tasks.includes('weekdays 09:00'))
  }
  assert.match(helpText('zh-CN', null, CONFIG_HANDLERS), /litch config：配置 Litch/)
  assert.match(helpText('en', null, CONFIG_HANDLERS), /litch config: configure Litch/)
})

// ---------- 对着模拟核心跑 ----------

function mock() {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  const command = (name: string, params: object) => core.command(name, params, never)
  const run = (argv: string[], more: { json?: boolean; lang?: 'zh-CN' | 'en' } = {}) =>
    command('config.run', { argv, ...more }) as Promise<{ ok: boolean; text: string }>
  /** 开一个“窗口”：看 config 主题 */
  const window = () => {
    const seen = { view: null as ConfigTopicView | null }
    const close = core.subscribe(
      { kind: 'config' },
      {
        snapshot: (data) => {
          seen.view = data as ConfigTopicView
        },
        delta: (ops) => {
          for (const op of ops as ConfigTopicOp[]) seen.view = op.view
        },
        error() {},
      },
    )
    return { seen, close }
  }
  const app = () =>
    new Promise<AppView>((resolve) => {
      const close = core.subscribe(
        { kind: 'app' },
        {
          snapshot: (data) => {
            resolve(data as AppView)
            queueMicrotask(close)
          },
          delta() {},
          error() {},
        },
      )
    })
  return { time, core, command, run, window, app }
}

/** 等执行器把事情交出来（它要先订几个主题拿快照） */
const flush = async () => {
  for (let i = 0; i < 6; i++) await settle()
}

test('读：status、devices list（--json 给结构化结果）；设备认 id、名字、local', async () => {
  const m = mock()
  const status = await m.run(['status'], { lang: 'en' })
  assert.ok(status.ok)
  assert.match(status.text, /local/)
  const list = await m.run(['devices', 'list'], { json: true, lang: 'en' })
  const parsed = JSON.parse(list.text) as { ok: boolean; op: string; data: { id: string }[] }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.op, 'devices list')
  assert.ok(parsed.data.some((device) => device.id === 'local'))
  assert.ok((await m.run(['harness', 'list', 'local'])).ok)
  assert.ok((await m.run(['harness', 'list', 'build-01'])).ok, '认 ssh 别名')
  const missing = await m.run(['harness', 'list', 'nowhere'], { lang: 'en' })
  assert.equal(missing.ok, false)
  assert.match(missing.text, /^\[litch:invalid\] No such device: nowhere/)
})

test('认不出的操作：说“这一版没有这个操作”并列出有的；参数不对带用法', async () => {
  const m = mock()
  const unknown = await m.run(['update', 'check'])
  assert.equal(unknown.ok, false)
  assert.match(unknown.text, /这一版 Litch 没有这个操作：update/)
  assert.match(unknown.text, /devices/)
  const action = await m.run(['tasks', 'explode'], { lang: 'en' })
  assert.match(action.text, /tasks has: list, create, update, pause, resume, run, delete/)
  const count = await m.run(['devices', 'rename', 'local'])
  assert.match(count.text, /参数个数不对/)
  assert.match(count.text, /用法：litch config devices rename/)
  const json = JSON.parse((await m.run(['devices', 'rename'], { json: true })).text)
  assert.deepEqual([json.ok, json.op, json.kind], [false, 'devices rename', 'invalid'])
})

test('界面那几项交给最近开的窗口，窗口做完回话；没有窗口当场没做成', async () => {
  const m = mock()
  const none = await m.run(['look', 'set', '--skin', 'human'], { lang: 'en' })
  assert.equal(none.ok, false)
  assert.match(none.text, /window/i)

  const older = m.window()
  const newer = m.window()
  const pending = m.run(['look', 'set', '--skin', 'human', '--zoom', '110'])
  await flush()
  assert.equal(older.seen.view?.asks.length, 0, '只交给最近订阅的那一个')
  const [ask] = newer.seen.view?.asks ?? []
  assert.deepEqual(ask?.request, { kind: 'prefs.set', patch: { skin: 'human', zoom: 1.1 } })
  await m.command('config.reply', {
    id: ask?.id,
    ok: true,
    data: {
      skin: 'human',
      theme: 'system',
      density: 'normal',
      zoom: 1.1,
      lang: 'zh-CN',
      linksInApp: true,
      notifySuccess: false,
    },
  })
  const done = await pending
  assert.ok(done.ok)
  assert.match(done.text, /human/)
  assert.equal(newer.seen.view?.asks.length, 0)
  await assert.rejects(m.command('config.reply', { id: ask?.id, ok: true }), { code: 'notFound' })

  // 窗口回“没做成”：原因给模型
  const opened = m.run(['open', 'settings/browser'], { lang: 'en' })
  await flush()
  const [open] = newer.seen.view?.asks ?? []
  assert.deepEqual(open?.request, {
    kind: 'open',
    place: { where: 'settings', section: 'browser' },
  })
  await m.command('config.reply', { id: open?.id, ok: false, reason: 'window is closing' })
  const failed = await opened
  assert.equal(failed.ok, false)
  assert.match(failed.text, /window is closing/)
})

test('phones pair：只打开出码对话框（带预填），回“请用手机扫码并在桌面端核对确认码”', async () => {
  const m = mock()
  const win = m.window()
  const pending = m.run(['phones', 'pair', 'local', '--host', 'mac.lan', '--port', '2222'])
  await flush()
  const [ask] = win.seen.view?.asks ?? []
  assert.deepEqual(ask?.request, {
    kind: 'pair',
    deviceId: 'local',
    prefill: { host: 'mac.lan', port: 2222 },
  })
  await m.command('config.reply', { id: ask?.id, ok: true })
  const done = await pending
  assert.ok(done.ok)
  assert.match(done.text, /扫码/)
  assert.match(done.text, /确认码/)
})

test('放宽安全（E6）：确认卡写清是哪一项，每个窗口都看得到；允许才执行，拒绝不执行', async () => {
  const m = mock()
  const a = m.window()
  const b = m.window()
  const allowed = m.run(['tools', 'set', 'local', '--computer', 'on'])
  await flush()
  const [card] = a.seen.view?.confirms ?? []
  assert.ok(card)
  assert.equal(b.seen.view?.confirms[0]?.id, card.id)
  assert.equal(card.command, 'tools set local --computer on')
  assert.equal(card.items[0]?.kind, 'tool')
  assert.equal(card.expiresAt, m.time.clock.now() + CONFIRM_TIMEOUT_MS)
  assert.equal((await m.app()).devices.find((d) => d.id === 'local')?.tools.computer, false)
  await m.command('config.confirm', { id: card.id, allow: true })
  assert.ok((await allowed).ok)
  assert.equal((await m.app()).devices.find((d) => d.id === 'local')?.tools.computer, true)
  assert.equal(a.seen.view?.confirms.length, 0)
  await assert.rejects(m.command('config.confirm', { id: card.id, allow: true }), {
    code: 'notFound',
  })

  const sites = await m.run(['browser', 'sites'])
  assert.ok(!sites.text.includes('example.org'))
  const declined = m.run(['browser', 'allow', 'example.org'], { lang: 'en' })
  await flush()
  const [site] = a.seen.view?.confirms ?? []
  assert.deepEqual(site?.items, [{ kind: 'site', origin: 'https://example.org' }])
  await m.command('config.confirm', { id: site?.id, allow: false })
  const no = await declined
  assert.equal(no.ok, false)
  assert.match(no.text, /^\[litch:declined\] The user declined/)
  assert.ok(!(await m.run(['browser', 'sites'])).text.includes('example.org'))
})

test('放宽安全（E6）：两分钟没人理算拒绝；一个窗口都没开着当场拒绝', async () => {
  const m = mock()
  const nobody = await m.run(['tools', 'set', 'local', '--computer', 'on'], { lang: 'en' })
  assert.equal(nobody.ok, false)
  assert.match(nobody.text, /No Litch window is open/)

  const win = m.window()
  const pending = m.run(['tools', 'set', 'local', '--computer', 'on'], { lang: 'en' })
  await flush()
  assert.equal(win.seen.view?.confirms.length, 1)
  m.time.advance(CONFIRM_TIMEOUT_MS)
  const late = await pending
  assert.equal(late.ok, false)
  assert.match(late.text, /within 2 minutes/)
  assert.equal(win.seen.view?.confirms.length, 0)
  assert.equal((await m.app()).devices.find((d) => d.id === 'local')?.tools.computer, false)
})

test('对话里“配置：…”：当成本机 harness 跑了一次，确认卡上写着是哪个会话', async () => {
  const m = mock()
  const win = m.window()
  await m.command('session.send', {
    deviceId: 'local',
    sessionId: 's3',
    text: '配置：tools set local --computer on',
  })
  await flush()
  const [card] = win.seen.view?.confirms ?? []
  assert.ok(card)
  assert.equal(card.session?.deviceId, 'local')
  assert.equal(card.session?.sessionId, 's3')
  await m.command('config.confirm', { id: card.id, allow: true })
  await flush()
  assert.equal((await m.app()).devices.find((d) => d.id === 'local')?.tools.computer, true)
})

// ---------- 接线：真的核心、假设备 ----------

function wired() {
  const fake = fakeDevice([harness('pi', { threads: [thread({ id: 'p1' })] })])
  fake.device.extensions = ['harness', 'clientTools']
  const local = fakeOpener(fake.handlers)
  const remote = fakeOpener(fakeDevice([harness('pi')]).handlers)
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    config: { lang: () => 'en' },
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'song@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: local.open,
      },
      {
        id: 'box',
        name: 'dev-box',
        host: 'dev@box',
        kind: 'ssh',
        target: { kind: 'host', host: 'box', port: null, user: 'dev', keyFile: null },
        wire: 'orange',
        open: remote.open,
      },
    ],
  })
  return { core, local, remote, time }
}

const capsOf = (server: { seen: { method: string; params: unknown }[] }) => {
  const init = server.seen.find((entry) => entry.method === 'initialize')
  assert.ok(init)
  return (init.params as { capabilities: Record<string, unknown> }).capabilities
}

const textOf = (message: JsonRpcMessage) => {
  const result = (message as { result?: ClientToolCallResponse }).result
  const first = result?.contentItems[0]
  return first?.type === 'inputText' ? first.text : ''
}

test('接线：只有本机的连接声明 litch_config；命令行调用交给执行器，结果给模型读', async () => {
  const w = wired()
  w.core.start()
  await settle()
  await settle()
  const near = capsOf(w.local.last()).litchClientTools as { namespaces: string[] }
  assert.deepEqual(near.namespaces, ['litch_config'])
  assert.equal(capsOf(w.remote.last()).litchClientTools, undefined)

  const reply = await w.local.last().ask('litch/clientTool/call', {
    callId: 'c1',
    namespace: 'litch_config',
    tool: 'run',
    arguments: { argv: ['devices', 'list'], json: false, lang: null },
    threadId: null,
    turnId: null,
    harness: 'pi',
  })
  const text = textOf(reply)
  assert.match(text, /local/)
  assert.match(text, /box/)
  // 别的工具名不认
  const other = await w.local.last().ask('litch/clientTool/call', {
    callId: 'c2',
    namespace: 'litch_config',
    tool: 'exec',
    arguments: {},
    threadId: null,
    turnId: null,
    harness: null,
  })
  assert.match(textOf(other), /^\[litch:/)
})
