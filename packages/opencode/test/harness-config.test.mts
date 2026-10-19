import assert from 'node:assert/strict'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { callbackPort, deviceCode } from '../src/harness-settings-providers.mjs'
import { OpencodeServer } from '../src/server.mjs'
import { client, type Isolated, text as input, isolate, skip, violations } from './client.mjs'
import { type MockResponder, scripted } from './mock-model.mjs'

// harness 详情设置（扩展 harnessConfig）在 OpenCode 上：读写的是隔离目录里 OpenCode 自己的全局配置、auth.json、
// AGENTS.md，经真的 opencode serve（凭据、清单、校验、重读都是它做的）。API key 都是假的，不发真实请求；
// OAuth 要联网，不在这里测（拿授权链接、设备码那一步的解析在下面单测）。

const H = { harness: 'opencode' }

type Scene = Isolated & { desktop: ReturnType<typeof client> }

async function scene(respond: MockResponder = scripted({})): Promise<Scene> {
  const env = await isolate(respond)
  const desktop = client(env.server, ['harnessConfig'])
  await desktop.initialize()
  return { ...env, desktop }
}

const configDir = (s: Isolated) => join(s.root, 'xdg', 'config', 'opencode')
const dataDir = (s: Isolated) => join(s.root, 'xdg', 'data', 'opencode')

async function rejects(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error.code, -32000)
    assert.equal(error.data?.litch, reason, error.message)
    assert.equal(error.data?.harness, 'opencode')
    return true
  })
}

test('授权链接里的回调端口、说明里的设备码', () => {
  assert.equal(
    callbackPort(
      'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=x',
    ),
    1455,
  )
  assert.equal(callbackPort('https://github.com/login/device'), null)
  assert.equal(callbackPort('https://x.test/a?redirect_uri=https%3A%2F%2Fexample.com%2Fcb'), null)
  assert.equal(deviceCode('Enter code: 5PX6-CGHJK'), '5PX6-CGHJK')
  assert.equal(
    deviceCode('Complete authorization in your browser. This window will close automatically.'),
    null,
  )
})

test('OpenCode：配置项读写保留注释、能删键、serve 跟着重读', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene()
  try {
    // 用户自己的 opencode.jsonc：带注释和认不出的键；它在就写它（OpenCode 自己也是这么挑的）
    const jsonc = join(configDir(s), 'opencode.jsonc')
    await writeFile(
      jsonc,
      '{\n  // 用户的注释\n  "$schema": "https://opencode.ai/config.json",\n  "unknownThing": { "a": 1 },\n  "permission": { "edit": "ask" }\n}\n',
    )
    const read = await s.desktop.call('litch/harness/config/read', H)
    const keys = read.settings.map((entry: any) => entry.key)
    for (const key of [
      'model',
      'small_model',
      'default_agent',
      'permission.*',
      'permission.edit',
      'share',
      'autoupdate',
      'provider.mock.blacklist',
    ])
      assert.ok(keys.includes(key), `缺 ${key}`)
    const model = read.settings.find((entry: any) => entry.key === 'model')
    assert.ok(model.options.some((option: any) => option.value === 'mock/m1'))
    assert.equal(read.values.model, 'mock/m1')
    assert.equal(read.values['permission.edit'], 'ask')
    assert.equal(read.values.share, 'disabled')
    assert.equal(read.values.autoupdate, 'false')
    assert.equal(read.files[0].path, jsonc)
    const agents = read.settings.find((entry: any) => entry.key === 'default_agent').options
    assert.ok(agents.some((option: any) => option.value === 'build'))
    assert.ok(!agents.some((option: any) => option.value === 'explore'), '子代理不该在默认代理里')

    const written = await s.desktop.call('litch/harness/config/write', {
      ...H,
      expectedVersion: read.version,
      edits: [
        { key: 'share', value: 'manual' },
        { key: 'autoupdate', value: 'notify' },
        { key: 'permission.*', value: 'allow' },
        { key: 'subagent_depth', value: 2 },
      ],
    })
    assert.equal(written.restartRequired, false)
    assert.notEqual(written.version, read.version)
    const after = await readFile(jsonc, 'utf8')
    assert.match(after, /\/\/ 用户的注释/)
    assert.match(after, /"unknownThing": \{ "a": 1 \}/)
    assert.doesNotMatch(after, /litch-reload/)
    // “*” 排在最前，不盖掉后面单列的 edit
    assert.ok(after.indexOf('"*"') < after.indexOf('"edit"'), after)
    const parsed = (await readFile(jsonc, 'utf8')).replace(/\/\/.*\n/, '\n')
    assert.deepEqual(JSON.parse(parsed).permission, { '*': 'allow', edit: 'ask' })
    assert.equal(JSON.parse(parsed).autoupdate, 'notify')
    // serve 已经重读：它报的全局配置里有新值
    const api = await s.server.api()
    const live = await api.request('GET', '/global/config')
    assert.equal(live.share, 'manual')
    assert.equal(live.subagent_depth, 2)
    await s.desktop.until('litch/harness/config/changed', (p) => p.part === 'config')

    // 删键回到默认；旧版本号写不进去；不合规矩的值不收
    await rejects(
      s.desktop.call('litch/harness/config/write', {
        ...H,
        expectedVersion: read.version,
        edits: [{ key: 'share', value: 'auto' }],
      }),
      'versionConflict',
    )
    await rejects(
      s.desktop.call('litch/harness/config/write', {
        ...H,
        expectedVersion: written.version,
        edits: [{ key: 'share', value: 'sometimes' }],
      }),
      'invalidValue',
    )
    const cleared = await s.desktop.call('litch/harness/config/write', {
      ...H,
      expectedVersion: written.version,
      edits: [
        { key: 'share', value: null },
        { key: 'provider.mock.blacklist', value: ['m-hidden'] },
      ],
    })
    const reread = await s.desktop.call('litch/harness/config/read', H)
    assert.equal(reread.version, cleared.version)
    // opencode.json 里还写着 disabled（合起来看仍是它），opencode.jsonc 里的删掉了
    assert.doesNotMatch(await readFile(jsonc, 'utf8'), /"share"/)
    assert.deepEqual(reread.values['provider.mock.blacklist'], ['m-hidden'])
    assert.deepEqual([...violations], [])
  } finally {
    await s.restore()
  }
})

test('OpenCode：默认模型从适配器元数据迁进原生配置，config/batchWrite 写原生配置', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene()
  let second: OpencodeServer | null = null
  try {
    const file = join(configDir(s), 'opencode.json')
    const original = JSON.parse(await readFile(file, 'utf8'))
    delete original.model
    await writeFile(file, JSON.stringify(original, null, 2))
    s.server.store.setMeta('config', 'defaults', {
      model: 'mock/m1',
      model_reasoning_effort: 'high',
    })
    await s.server.close()
    second = new OpencodeServer(s.home)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).model, 'mock/m1')
    assert.deepEqual(second.store.getMeta('config', 'defaults'), { model_reasoning_effort: 'high' })
    const desktop = client(second)
    await desktop.initialize()
    const config = await desktop.call('config/read', {})
    assert.equal(config.config.model, 'mock/m1')
    assert.equal(config.config.model_reasoning_effort, 'high')
    await desktop.call('config/batchWrite', { edits: [{ keyPath: 'model', value: null }] })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).model, undefined)
    await desktop.call('config/batchWrite', { edits: [{ keyPath: 'model', value: 'mock/m1' }] })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).model, 'mock/m1')
    assert.equal(second.store.getMeta('config', 'defaults').model, undefined)
  } finally {
    await second?.close()
    await s.restore()
  }
})

test('OpenCode：provider 的 API key、断开、自定义 provider', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene()
  try {
    const auth = join(dataDir(s), 'auth.json')
    const first = await s.desktop.call('litch/harness/providers/read', H)
    assert.equal(first.switchable, false)
    assert.equal(first.templates[0].id, 'openai-compatible')
    const anthropic = first.providers.find((entry: any) => entry.id === 'anthropic')
    assert.ok(anthropic, '应当列出 anthropic')
    assert.equal(anthropic.auth.signedIn, false)
    const api = anthropic.methods.find((entry: any) => entry.kind === 'apiKey')
    assert.ok(api.fields.some((field: any) => field.id === 'key' && field.secret))
    assert.ok(
      anthropic.methods.some(
        (entry: any) => entry.kind === 'env' && entry.envName === 'ANTHROPIC_API_KEY',
      ),
    )

    const started = await s.desktop.call('litch/harness/auth/start', {
      ...H,
      providerId: 'anthropic',
      methodId: api.id,
      inputs: { key: 'sk-ant-fake-not-real-7890' },
    })
    assert.equal(started.step.kind, 'done')
    assert.equal(started.step.auth.label, '…7890')
    assert.equal(
      JSON.parse(await readFile(auth, 'utf8')).anthropic.key,
      'sk-ant-fake-not-real-7890',
    )
    const connected = await s.desktop.call('litch/harness/providers/read', H)
    const now = connected.providers.find((entry: any) => entry.id === 'anthropic')
    assert.deepEqual(now.auth, { signedIn: true, kind: 'apiKey', label: '…7890' })
    assert.equal(now.canLogout, true)
    assert.equal(connected.providers[0].auth.signedIn, true, '已连上的排在前面')
    await s.desktop.call('litch/harness/auth/logout', { ...H, providerId: 'anthropic' })
    assert.equal(JSON.parse(await readFile(auth, 'utf8')).anthropic, undefined)
    await rejects(
      s.desktop.call('litch/harness/auth/logout', { ...H, providerId: 'anthropic' }),
      'notFound',
    )
    await rejects(
      s.desktop.call('litch/harness/providers/activate', {
        ...H,
        providerId: 'anthropic',
        expectedVersion: '',
      }),
      'readOnly',
    )

    // 自定义 OpenAI 兼容 provider：配置进 provider.<id>，key 进 auth.json
    const version = (await s.desktop.call('litch/harness/providers/read', H)).version
    await s.desktop.call('litch/harness/providers/upsert', {
      ...H,
      providerId: 'mygw',
      templateId: 'openai-compatible',
      expectedVersion: version,
      definition: {
        name: 'My Gateway',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: 'gw-fake-key-abcdef',
        models: ['gm1=GW Model', 'gm2'],
        headers: ['X-Test: 1'],
      },
    })
    const config = JSON.parse(await readFile(join(configDir(s), 'opencode.json'), 'utf8'))
    assert.deepEqual(config.provider.mygw, {
      npm: '@ai-sdk/openai-compatible',
      name: 'My Gateway',
      options: { baseURL: 'http://127.0.0.1:9/v1', headers: { 'X-Test': '1' } },
      models: { gm1: { name: 'GW Model' }, gm2: { name: 'gm2' } },
    })
    assert.equal(JSON.parse(await readFile(auth, 'utf8')).mygw.key, 'gw-fake-key-abcdef')
    const listed = await s.desktop.call('litch/harness/providers/read', H)
    const custom = listed.providers.find((entry: any) => entry.id === 'mygw')
    assert.equal(custom.kind, 'custom')
    assert.equal(custom.auth.signedIn, true)
    assert.deepEqual(custom.definition, {
      name: 'My Gateway',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: { set: true },
      models: ['gm1=GW Model', 'gm2'],
      headers: ['X-Test: 1'],
    })
    // 新的模型出现在模型列表里（serve 重读过了）
    const models = await s.desktop.call('model/list', {})
    assert.ok(models.data.some((entry: any) => entry.id === 'mygw/gm1'))
    await rejects(
      s.desktop.call('litch/harness/providers/upsert', {
        ...H,
        providerId: 'anthropic',
        templateId: 'openai-compatible',
        expectedVersion: listed.version,
        definition: { name: 'x', baseURL: 'http://127.0.0.1:9', models: ['a'] },
      }),
      'invalidValue',
    )
    await s.desktop.call('litch/harness/providers/remove', { ...H, providerId: 'mygw' })
    assert.equal(
      JSON.parse(await readFile(join(configDir(s), 'opencode.json'), 'utf8')).provider.mygw,
      undefined,
    )
    assert.equal(JSON.parse(await readFile(auth, 'utf8')).mygw, undefined)
    await s.desktop.until('litch/harness/config/changed', (p) => p.part === 'providers')
    assert.deepEqual([...violations], [])
  } finally {
    await s.restore()
  }
})

test('OpenCode：MCP 增改删、密钥不回显、指令文件', { skip, timeout: 120000 }, async () => {
  const s = await scene()
  try {
    const file = join(configDir(s), 'opencode.json')
    const read = await s.desktop.call('litch/harness/mcp/read', H)
    assert.deepEqual(read.servers, [])
    assert.deepEqual(read.transports, ['stdio', 'http'])
    const added = await s.desktop.call('litch/harness/mcp/upsert', {
      ...H,
      expectedVersion: read.version,
      server: {
        name: 'local-one',
        transport: 'stdio',
        enabled: false,
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        env: { API_KEY: 'secret-value', MODE: 'x' },
        extra: { timeout: 3000 },
      },
    })
    const listed = await s.desktop.call('litch/harness/mcp/read', H)
    const local = listed.servers.find((entry: any) => entry.name === 'local-one')
    assert.equal(local.enabled, false)
    assert.deepEqual(local.env, { API_KEY: '', MODE: 'x' })
    assert.deepEqual(local.secretKeys, ['API_KEY'])
    assert.deepEqual(local.extra, { timeout: 3000 })
    // 密钥原样交回空串表示不改；改名
    await s.desktop.call('litch/harness/mcp/upsert', {
      ...H,
      expectedVersion: added.version,
      previousName: 'local-one',
      server: { ...local, name: 'local-two', env: { API_KEY: '', MODE: 'y' } },
    })
    let config = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(config.mcp['local-one'], undefined)
    assert.deepEqual(config.mcp['local-two'], {
      type: 'local',
      command: ['node', '-e', 'process.exit(0)'],
      environment: { API_KEY: 'secret-value', MODE: 'y' },
      enabled: false,
      timeout: 3000,
    })
    const version = (await s.desktop.call('litch/harness/mcp/read', H)).version
    await s.desktop.call('litch/harness/mcp/upsert', {
      ...H,
      expectedVersion: version,
      server: {
        name: 'remote-one',
        transport: 'http',
        enabled: true,
        url: 'http://127.0.0.1:9/mcp',
        bearerTokenEnvVar: 'MY_TOKEN',
        extra: { oauth: false },
      },
    })
    config = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(config.mcp['remote-one'], {
      type: 'remote',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer {env:MY_TOKEN}' },
      oauth: false,
    })
    const both = await s.desktop.call('litch/harness/mcp/read', H)
    const remote = both.servers.find((entry: any) => entry.name === 'remote-one')
    assert.equal(remote.bearerTokenEnvVar, 'MY_TOKEN')
    assert.deepEqual(remote.headers, {})
    assert.ok(remote.status, 'serve 重读过，状态应当问得到')
    await rejects(
      s.desktop.call('litch/harness/mcp/login', { ...H, name: 'local-two' }),
      'invalidValue',
    )
    await s.desktop.call('litch/harness/mcp/remove', {
      ...H,
      name: 'remote-one',
      expectedVersion: both.version,
    })
    await rejects(
      s.desktop.call('litch/harness/mcp/remove', {
        ...H,
        name: 'remote-one',
        expectedVersion: both.version,
      }),
      'versionConflict',
    )
    assert.equal(JSON.parse(await readFile(file, 'utf8')).mcp['remote-one'], undefined)

    // 指令文件：AGENTS.md 不在时如实报出 OpenCode 退回去读的 ~/.claude/CLAUDE.md
    const agents = join(configDir(s), 'AGENTS.md')
    let info = await s.desktop.call('litch/harness/instructions/read', H)
    assert.deepEqual(
      { path: info.path, exists: info.exists, hash: info.hash, overriddenBy: info.overriddenBy },
      { path: agents, exists: false, hash: '', overriddenBy: null },
    )
    await mkdir(join(s.root, 'home', '.claude'), { recursive: true })
    await writeFile(join(s.root, 'home', '.claude', 'CLAUDE.md'), '# claude\n')
    info = await s.desktop.call('litch/harness/instructions/read', H)
    assert.equal(info.overriddenBy, join(s.root, 'home', '.claude', 'CLAUDE.md'))
    const wrote = await s.desktop.call('litch/harness/instructions/write', {
      ...H,
      content: '# 我的规矩\n',
      expectedHash: '',
    })
    info = await s.desktop.call('litch/harness/instructions/read', H)
    assert.equal(info.content, '# 我的规矩\n')
    assert.equal(info.hash, wrote.hash)
    assert.equal(info.overriddenBy, null)
    await rejects(
      s.desktop.call('litch/harness/instructions/write', { ...H, content: 'x', expectedHash: '' }),
      'versionConflict',
    )
    // 统一模式下这里是软链：写进它指向的文件，软链留着
    const shared = join(s.root, 'shared.md')
    await writeFile(shared, 'shared\n')
    await rm(agents)
    await symlink(shared, agents)
    info = await s.desktop.call('litch/harness/instructions/read', H)
    assert.equal(info.linkTarget, shared)
    await s.desktop.call('litch/harness/instructions/write', {
      ...H,
      content: 'changed\n',
      expectedHash: info.hash,
    })
    assert.ok(lstatSync(agents).isSymbolicLink())
    assert.equal(await readFile(shared, 'utf8'), 'changed\n')
    await s.desktop.until('litch/harness/config/changed', (p) => p.part === 'instructions')
    assert.ok(!existsSync(join(configDir(s), 'opencode.jsonc')), '不该另建 opencode.jsonc')
    assert.deepEqual([...violations], [])
  } finally {
    await s.restore()
  }
})

test('OpenCode：有回合在跑时只写文件，回合照常结束后 serve 再重读；OpenCode 不收的配置整个退回', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene(
    scripted({
      SLOW: [
        [
          { type: 'wait', ms: 4000 },
          { type: 'text', chunks: ['完成'] },
        ],
      ],
    }),
  )
  try {
    const file = join(configDir(s), 'opencode.json')
    const api = await s.server.api()
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const { turn } = await s.desktop.call('turn/start', {
      threadId: thread.id,
      input: input('SLOW'),
    })
    await s.desktop.until('turn/started', (p) => p.turn.id === turn.id)
    const read = await s.desktop.call('litch/harness/config/read', H)
    await s.desktop.call('litch/harness/config/write', {
      ...H,
      expectedVersion: read.version,
      edits: [{ key: 'share', value: 'manual' }],
    })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).share, 'manual')
    // serve 还没重读（重读会停掉这个回合）
    assert.equal((await api.request('GET', '/global/config')).share, 'disabled')
    const done = await s.desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
    assert.equal(done.turn.status, 'completed')
    let share = 'disabled'
    for (let waited = 0; waited < 15000 && share !== 'manual'; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      share = (await api.request('GET', '/global/config')).share
    }
    assert.equal(share, 'manual', '回合结束后 serve 应当重读了配置')

    // 不合 OpenCode 规矩的配置：它校验不过，文件恢复原样
    const before = await readFile(file, 'utf8')
    const current = await s.desktop.call('litch/harness/config/read', H)
    await rejects(
      s.desktop.call('litch/harness/config/write', {
        ...H,
        expectedVersion: current.version,
        edits: [{ key: 'permission', value: { edit: 'maybe' } }],
      }),
      'invalidValue',
    )
    assert.equal(await readFile(file, 'utf8'), before)
    assert.deepEqual([...violations], [])
  } finally {
    await s.restore()
  }
})
