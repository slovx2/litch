// harness 详情设置（harnessConfig 扩展）在核心这一头：握手声明、设备和 harness 两级声明决定能不能用、
// 主题开着才读四块、别处改了重读并记一次（自己写的回声不算）、版本冲突重读、登录的步骤和回调转发、
// env 方式写设备设置的环境变量表（别的密钥不带值）、统一模式先读一遍各份拿路径。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  HarnessAuthStep,
  HarnessConfigReadResponse,
  HarnessInstructionsInfo,
  HarnessProvidersReadResponse,
} from '../../protocol/src/harness-config.mjs'
import {
  type AppView,
  createCore,
  type HarnessConfigOp,
  type HarnessConfigTopicView,
  type RemoteTarget,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { fakeSettings } from './fake-settings.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }
const text = (zh: string) => ({ 'zh-CN': zh, en: `EN ${zh}` })

const CONFIG = (version: string, model: string): HarnessConfigReadResponse => ({
  groups: [{ id: 'defaults', title: text('默认'), description: null }],
  settings: [
    {
      key: 'model',
      group: 'defaults',
      type: 'enum',
      title: text('模型'),
      description: null,
      default: 'a',
      effect: 'newSession',
      options: [{ value: 'a', title: text('A') }],
      allowCustom: true,
    },
  ],
  values: { model },
  actions: [],
  version,
  files: [{ role: 'settings', path: '/home/dev/.pi/agent/settings.json' }],
})

const PROVIDERS = (signedIn: boolean): HarnessProvidersReadResponse => ({
  providers: [
    {
      id: 'openai',
      title: text('OpenAI'),
      kind: 'builtin',
      auth: { signedIn, kind: signedIn ? 'oauth' : 'none', label: null },
      methods: [{ id: 'browser', kind: 'oauthBrowser', title: text('浏览器'), description: null }],
      active: true,
      canLogout: signedIn,
    },
  ],
  switchable: true,
  templates: [],
  version: 'p1',
})

const instructions = (path: string, linkTarget: string | null): HarnessInstructionsInfo => ({
  path,
  fileName: 'AGENTS.md',
  exists: true,
  content: 'hi',
  hash: 'h1',
  linkTarget,
  overriddenBy: null,
})

function world(options: { deviceExtension?: boolean; target?: RemoteTarget | null } = {}) {
  const fake = fakeDevice([
    harness('pi', { declaration: { extensions: ['harnessConfig'] } }),
    harness('claude-code', { declaration: { extensions: ['harnessConfig'] } }),
    harness('dsh', { declaration: { extensions: [] } }),
  ])
  fake.device.extensions = [
    'harness',
    'deviceSettings',
    ...(options.deviceExtension === false ? [] : ['harnessConfig']),
  ]
  const settings = fakeSettings()
  const state = {
    version: 'v1',
    model: 'a',
    signedIn: false,
    conflictNext: false,
    links: new Map<string, string | null>([
      ['pi', null],
      ['claude-code', null],
    ]),
  }
  const peer = fakeOpener({
    ...fake.handlers,
    ...settings.handlers,
    'litch/harness/config/read': () => CONFIG(state.version, state.model),
    'litch/harness/config/write': (params) => {
      const { expectedVersion, edits } = params as {
        expectedVersion: string
        edits: { key: string; value: unknown }[]
      }
      if (state.conflictNext || expectedVersion !== state.version) {
        state.conflictNext = false
        state.version = 'v9'
        throw new RpcFailure(-32000, 'conflict', { litch: 'versionConflict', harness: 'pi' })
      }
      state.model = String(edits[0]?.value)
      state.version = `${state.version}x`
      return { version: state.version, overriddenKeys: [], restartRequired: true }
    },
    'litch/harness/providers/read': () => PROVIDERS(state.signedIn),
    'litch/harness/mcp/read': () => ({
      servers: [{ name: 'fetch', transport: 'stdio', enabled: true, command: 'uvx' }],
      transports: ['stdio'],
      oauth: false,
      extraFields: [],
      version: 'm1',
      files: [],
    }),
    'litch/harness/instructions/read': (params) => {
      const id = (params as { harness: string }).harness
      if (id === 'claude-code') {
        return {
          ...instructions('/home/dev/.claude/CLAUDE.md', state.links.get(id) ?? null),
          fileName: 'CLAUDE.md',
        }
      }
      return instructions(`/home/dev/.${id}/AGENTS.md`, state.links.get(id) ?? null)
    },
    'litch/harness/auth/start': (): { attemptId: string; step: HarnessAuthStep } => ({
      attemptId: 'at1',
      step: { kind: 'openUrl', url: 'https://auth.example/x', callbackPort: 1455, message: null },
    }),
    'litch/device/instructions/unify': (params) => {
      const { linkPaths } = params as { linkPaths: string[] }
      return { results: linkPaths.map((path) => ({ path, outcome: 'linked', backup: null })) }
    },
  })
  const forwards: { deviceId: string; port: number }[] = []
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    forward: {
      async open(deviceId, _target, port) {
        forwards.push({ deviceId, port })
      },
    },
    devices: [
      {
        id: 'dev',
        name: 'build-01',
        host: 'dev@build-01',
        kind: options.target === null ? 'local' : 'ssh',
        target:
          options.target === undefined ? { kind: 'alias', alias: 'build-01' } : options.target,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'dev', ...params }, never)
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const watch = (id = 'pi') => {
    const seen = { view: null as HarnessConfigTopicView | null }
    const close = core.subscribe(
      { kind: 'harnessConfig', deviceId: 'dev', harness: id },
      {
        snapshot: (data) => {
          seen.view = data as HarnessConfigTopicView
        },
        delta: (ops) => {
          for (const op of ops as HarnessConfigOp[]) seen.view = op.view
        },
        error() {},
      },
    )
    return { seen, close }
  }
  return { core, peer, time, state, settings, forwards, command, sent, broadcast, watch }
}

async function started(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  w.core.start()
  for (let i = 0; i < 4; i++) await settle()
  return w
}

const drain = async () => {
  for (let i = 0; i < 6; i++) await settle()
}

test('握手声明 harnessConfig；两级都声明了才算有详情设置', async () => {
  const w = await started()
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')
  assert.ok(init, '握手发出去了')
  const caps = (init.params as { capabilities: { litchExtensions: string[] } }).capabilities
  assert.ok(caps.litchExtensions.includes('harnessConfig'))
  const app = await new Promise<AppView>((resolve) => {
    w.core.subscribe(
      { kind: 'app' },
      { snapshot: (data) => resolve(data as AppView), delta() {}, error() {} },
    )
  })
  const configurable = Object.fromEntries(
    (app.devices[0]?.harnesses ?? []).map((entry) => [entry.id, entry.configurable]),
  )
  assert.deepEqual(configurable, { pi: true, 'claude-code': true, dsh: false })

  const dsh = w.watch('dsh')
  await drain()
  assert.equal(dsh.seen.view?.supported, false)
  await assert.rejects(w.command('harnessConfig.reload', { harness: 'dsh' }), {
    code: 'unsupported',
  })
})

test('设备那一级没声明：harness 自己声明了也不算', async () => {
  const w = await started({ deviceExtension: false })
  const pi = w.watch('pi')
  await drain()
  assert.equal(pi.seen.view?.supported, false)
  assert.equal(w.sent('litch/harness/config/read').length, 0)
})

test('打开才读四块；别处改了重读并记一次，自己写的回声不算', async () => {
  const w = await started()
  assert.equal(w.sent('litch/harness/config/read').length, 0)
  const pi = w.watch('pi')
  await drain()
  const view = pi.seen.view
  assert.equal(view?.supported, true)
  assert.equal(view?.config.data?.values.model, 'a')
  assert.equal(view?.providers.data?.providers[0]?.id, 'openai')
  assert.equal(view?.mcp.data?.servers[0]?.command, 'uvx')
  assert.equal(view?.instructions.data?.path, '/home/dev/.pi/AGENTS.md')
  // 声明里没写的补上了：能清掉、不只读
  assert.equal(view?.config.data?.settings[0]?.clearable, true)

  w.state.model = 'b'
  w.broadcast('litch/harness/config/changed', { harness: 'pi', part: 'config' })
  await drain()
  assert.equal(pi.seen.view?.config.data?.values.model, 'b')
  assert.equal(pi.seen.view?.config.revision, 1)

  const result = (await w.command('harnessConfig.write', {
    harness: 'pi',
    edits: [{ key: 'model', value: 'c' }],
    expectedVersion: 'v1',
  })) as { restartRequired: boolean }
  assert.equal(result.restartRequired, true)
  w.broadcast('litch/harness/config/changed', { harness: 'pi', part: 'config' })
  await drain()
  assert.equal(pi.seen.view?.config.data?.values.model, 'c')
  assert.equal(pi.seen.view?.config.revision, 1, '自己写的那一下不算被别处改过')
  assert.equal(pi.seen.view?.restartRequired, true)
})

test('版本冲突：以 conflict 结束，那一块重读', async () => {
  const w = await started()
  const pi = w.watch('pi')
  await drain()
  const before = w.sent('litch/harness/config/read').length
  w.state.conflictNext = true
  await assert.rejects(
    w.command('harnessConfig.write', {
      harness: 'pi',
      edits: [{ key: 'model', value: 'z' }],
      expectedVersion: 'v1',
    }),
    { code: 'conflict' },
  )
  await drain()
  assert.equal(w.sent('litch/harness/config/read').length, before + 1)
  assert.equal(pi.seen.view?.config.data?.version, 'v9')
})

test('浏览器登录：远程设备先把回调端口转过去；完成的通知到了 provider 重读', async () => {
  const w = await started()
  const pi = w.watch('pi')
  await drain()
  const { attemptId } = (await w.command('harnessConfig.auth.start', {
    harness: 'pi',
    providerId: 'openai',
    methodId: 'browser',
  })) as { attemptId: string }
  await drain()
  assert.equal(attemptId, 'at1')
  assert.deepEqual(w.forwards, [{ deviceId: 'dev', port: 1455 }])
  const attempt = pi.seen.view?.attempts[0]
  assert.equal(attempt?.step.kind, 'openUrl')
  assert.deepEqual(attempt?.forward, { port: 1455, state: 'ready', message: null })

  w.state.signedIn = true
  w.broadcast('litch/harness/auth/updated', {
    harness: 'pi',
    attemptId: 'at1',
    providerId: 'openai',
    step: { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: 'me' } },
  })
  await drain()
  assert.equal(pi.seen.view?.attempts[0]?.step.kind, 'done')
  assert.equal(pi.seen.view?.providers.data?.providers[0]?.auth.signedIn, true)
})

test('本机设备不转发回调端口', async () => {
  const w = await started({ target: null })
  w.watch('pi')
  await drain()
  await w.command('harnessConfig.auth.start', {
    harness: 'pi',
    providerId: 'openai',
    methodId: 'browser',
  })
  await drain()
  assert.deepEqual(w.forwards, [])
})

test('env 方式：写进这个 harness 的环境变量表，别的密钥不带值、普通变量照旧', async () => {
  const w = await started()
  await w.command('harnessConfig.env.set', {
    harness: 'pi',
    name: 'LITELLM_API_KEY',
    value: 'sk-x',
  })
  const write = w.settings.settings.writes.at(-1)
  assert.deepEqual(write?.edits, [
    {
      key: 'harness.pi.env',
      value: [
        { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
        { name: 'PI_API_KEY', secret: true },
        { name: 'LITELLM_API_KEY', value: 'sk-x', secret: true },
      ],
    },
  ])
  await assert.rejects(
    w.command('harnessConfig.env.set', { harness: 'pi', name: '1bad', value: 'x' }),
    { code: 'invalid' },
  )
})

test('统一模式：先读各份拿路径，把选中的写成真文件、其余改成软链；之后认得出是统一模式', async () => {
  const w = await started()
  const { results } = (await w.command('instructions.unify', {
    harness: 'pi',
    content: '# all',
  })) as { results: { path: string }[] }
  const call = w.sent('litch/device/instructions/unify')[0]
  assert.deepEqual(call, {
    sourcePath: '/home/dev/.pi/AGENTS.md',
    content: '# all',
    linkPaths: ['/home/dev/.claude/CLAUDE.md'],
  })
  assert.deepEqual(
    results.map((one) => one.path),
    ['/home/dev/.claude/CLAUDE.md'],
  )
  w.state.links.set('claude-code', '/home/dev/.pi/AGENTS.md')
  const overview = (await w.command('instructions.overview')) as {
    unified: { sourcePath: string; harness: string | null } | null
  }
  assert.deepEqual(overview.unified, { sourcePath: '/home/dev/.pi/AGENTS.md', harness: 'pi' })
})
