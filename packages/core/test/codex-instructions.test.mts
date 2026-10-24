// 直连原生 codex 时开发者指令由核心补齐（src/device/codex-instructions.mts）：建会话把命名空间上的规则拼到 config.toml
// 那段后面、按会话记下命名空间，恢复、分叉时按这一版重拼带上；没记过的会话、对面不是原生 codex 的都不动。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_PROPOSAL_RULES, SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import {
  CODEX_THREAD_NOTES_MAX,
  type CodexThreadNotes,
  checkCodexThreadNotes,
  createDirectInstructions,
} from '../src/device/codex-instructions.mjs'
import { createCore, type DeviceStore, type SavedDevices } from '../src/index.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const CONFIG = 'From config.toml.'
const RULES = `# Tool instructions: litch_sessions\n${SESSION_PROPOSAL_RULES}`
const RULED = { ...ECHO_TOOLS, name: 'litch_ruled', instructions: 'Old rules.' }

function rig(options: { notes?: CodexThreadNotes | null; failRead?: boolean } = {}) {
  const asked: unknown[] = []
  const logs: string[] = []
  const saved: CodexThreadNotes[] = []
  const time = fakeClock()
  const direct = createDirectInstructions({
    clock: time.clock,
    store: {
      load: () => options.notes ?? null,
      save: (notes) => saved.push(structuredClone(notes)),
    },
    async ask(method, params) {
      asked.push({ method, params })
      if (options.failRead) throw new Error('boom')
      return { config: { developer_instructions: CONFIG } }
    },
    // 这一版的规则：litch_ruled 换了说法
    specs: (names) =>
      names.flatMap((name) =>
        name === RULED.name ? [{ ...RULED, instructions: 'New rules.' }] : [],
      ),
    cwdOf: (threadId) => (threadId === 'a' ? '/work/a' : null),
    log: (line) => logs.push(line),
  })
  return { direct, asked, logs, saved, time }
}

test('直连建会话：规则拼在 config.toml 那段后面（config/read 带 cwd），工具上的规则摘掉；应答回来按会话记下命名空间', async () => {
  const { direct, asked, saved } = rig()
  const prepared = await direct.prepare('thread/start', {
    cwd: '/work/a',
    dynamicTools: [ECHO_TOOLS, RULED],
  })
  assert.ok(prepared)
  assert.deepEqual(asked, [{ method: 'config/read', params: { cwd: '/work/a' } }])
  assert.equal(
    prepared.params.developerInstructions,
    `${CONFIG}\n\n# Tool instructions: litch_ruled\nOld rules.`,
  )
  const tools = prepared.params.dynamicTools as Record<string, unknown>[]
  assert.equal(
    tools.some((spec) => 'instructions' in spec),
    false,
  )
  prepared.remember({ thread: { id: 'new', cwd: '/work/a' } })
  assert.deepEqual(Object.keys(saved.at(-1)?.threads ?? {}), ['new'])
  assert.deepEqual(saved.at(-1)?.threads.new?.namespaces, ['litch_ruled'])
  // 没有规则的会话：照转，不问、不记
  assert.equal(direct.prepare('thread/start', { cwd: '/w', dynamicTools: [ECHO_TOOLS] }), null)
  assert.equal(direct.prepare('turn/start', { threadId: 'new' }), null)
})

test('直连恢复、分叉：记过的会话按这一版的规则重拼，底子重新问 config.toml（目录取侧栏里的）；分叉出来的用新号记；没记过的不动', async () => {
  const notes: CodexThreadNotes = { threads: { a: { namespaces: ['litch_ruled'], at: 1 } } }
  const { direct, asked, saved, time } = rig({ notes })
  const resumed = await direct.prepare('thread/resume', { threadId: 'a' })
  assert.ok(resumed)
  assert.deepEqual(asked.at(-1), { method: 'config/read', params: { cwd: '/work/a' } })
  assert.equal(
    resumed.params.developerInstructions,
    `${CONFIG}\n\n# Tool instructions: litch_ruled\nNew rules.`,
  )
  resumed.remember({ thread: { id: 'a' } })
  assert.equal(saved.at(-1)?.threads.a?.at, time.clock.now())
  const forked = await direct.prepare('thread/fork', { threadId: 'a', lastTurnId: 't1' })
  assert.ok(forked)
  assert.equal(forked.params.developerInstructions, resumed.params.developerInstructions)
  forked.remember({ thread: { id: 'f1', cwd: '/work/a' } })
  assert.deepEqual(saved.at(-1)?.threads.f1?.namespaces, ['litch_ruled'])
  // 调用方自己给了：当底子，不问 config.toml
  const before = asked.length
  const own = await direct.prepare('thread/resume', {
    threadId: 'f1',
    developerInstructions: 'Mine.',
  })
  assert.equal(
    own?.params.developerInstructions,
    'Mine.\n\n# Tool instructions: litch_ruled\nNew rules.',
  )
  assert.equal(asked.length, before)
  assert.equal(direct.prepare('thread/resume', { threadId: 'elsewhere' }), null)
})

test('直连 config/read 失败：只放规则，记一行日志；记录超过上限丢最久没用到的；读回来的记录形状不对的当没记过', async () => {
  const { direct, logs, saved, time } = rig({ failRead: true })
  const prepared = await direct.prepare('thread/start', { dynamicTools: [RULED] })
  assert.equal(
    prepared?.params.developerInstructions,
    '# Tool instructions: litch_ruled\nOld rules.',
  )
  assert.ok(logs.some((line) => line.includes('boom')))
  for (let index = 0; index <= CODEX_THREAD_NOTES_MAX; index++) {
    time.advance(1)
    prepared?.remember({ thread: { id: `t${index}` } })
  }
  const threads = saved.at(-1)?.threads ?? {}
  assert.equal(Object.keys(threads).length, CODEX_THREAD_NOTES_MAX)
  assert.equal(threads.t0, undefined)
  assert.ok(threads[`t${CODEX_THREAD_NOTES_MAX}`])

  assert.equal(checkCodexThreadNotes(null), null)
  assert.equal(checkCodexThreadNotes({ threads: [] }), null)
  assert.deepEqual(
    checkCodexThreadNotes({
      threads: { a: { namespaces: ['x', 3, ''], at: 5 }, b: { namespaces: [], at: 1 }, c: 'no' },
    }),
    { threads: { a: { namespaces: ['x'], at: 5 } } },
  )
})

/** 一台设备，对面是原生 codex（不认识 runtime/info）或者适配器的单个入口；这台电脑上记过会话 a 带 litch_sessions */
function world(runtime: boolean) {
  const handlers: Record<string, Handler> = {
    'config/read': () => ({ config: { developer_instructions: CONFIG }, origins: {} }),
    'thread/list': () => ({
      data: [thread({ id: 'a', cwd: '/work/a', turns: [] })],
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/resume': () => ({
      thread: thread({ id: 'a', cwd: '/work/a', turns: [] }),
      model: 'm',
      reasoningEffort: null,
      sandbox: { type: 'readOnly' },
    }),
    ...(runtime
      ? {
          'runtime/info': () => ({
            engine: 'pi',
            protocolVersion: '0.163.0',
            cliBuild: '0.99.1',
            capabilities: [],
            releaseReady: true,
          }),
        }
      : {}),
  }
  const peer = fakeOpener(handlers)
  const saved: SavedDevices = { localWire: null, remotes: [] }
  const store: DeviceStore = {
    load: () => saved,
    save() {},
    snapshot: () => ({ load: () => null, save() {} }),
    codexThreads: () => ({
      load: () => ({ threads: { a: { namespaces: [SESSION_TOOLS.name], at: 1 } } }),
      save() {},
    }),
    forget() {},
  }
  const core = createCore({
    clock: fakeClock().clock,
    version: '9.9.9',
    store,
    log: () => {},
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
  return { core, peer }
}

test('直连原生 codex 打开记过的会话：恢复带上 config.toml 那段加这一版的规则；对面是适配器的入口时不补', async () => {
  for (const runtime of [false, true]) {
    const { core, peer } = world(runtime)
    core.start()
    await settle()
    const session = watchSession(core)
    for (let index = 0; index < 20 && !session.seen.view; index++) await settle()
    const resume = peer.last().seen.find((entry) => entry.method === 'thread/resume')
    assert.ok(resume, `runtime=${runtime}`)
    const params = resume.params as Record<string, unknown>
    if (runtime) assert.equal('developerInstructions' in params, false)
    else assert.equal(params.developerInstructions, `${CONFIG}\n\n${RULES}`)
    session.close()
    core.stop()
  }
})
