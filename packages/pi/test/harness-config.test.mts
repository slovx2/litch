import assert from 'node:assert/strict'
import { lstat, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness, pause } from './approval-harness.mjs'

// harness 详情设置（litch/harness/*）：读写的都是临时代理目录（PI_CODING_AGENT_DIR）里 Pi 自己的文件，
// 真实的 ~/.pi 不碰；API key 用假值，OAuth 只走到拿到授权链接为止。

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

async function setup() {
  const h = await approvalHarness({
    approvals: false,
    // 夹具的设置上再加几样认不出的键，写的时候要原样留着
    prepare: async (agentDir) => {
      const path = join(agentDir, 'settings.json')
      await writeFile(
        path,
        JSON.stringify({ ...(await json(path)), theme: 'dark', someFuture: { nested: 1 } }),
      )
    },
  })
  const declared = await h.connect('litch', ['harnessConfig'])
  const plain = await h.connect('desktop')
  return { h, c: declared, plain }
}

/** 调一个应当失败的方法，返回错误 */
async function failure(c: any, method: string, params: any) {
  const reply = await c.call(method, { harness: 'pi', ...params })
  assert.ok(reply.error, `${method} 应当失败`)
  return reply.error
}

test('HC-PI-001：配置项读写 settings.json，留着认不出的键，版本冲突和非法值照约定报错', {
  timeout: 60000,
}, async () => {
  const { h, c, plain } = await setup()
  try {
    const read = await c.ok('litch/harness/config/read', { harness: 'pi' })
    assert.deepEqual(
      read.groups.map((g: any) => g.id),
      ['defaults', 'network', 'behavior', 'tools'],
    )
    assert.equal(read.values.defaultProvider, 'gate')
    assert.equal(read.values.defaultModel, 'gate')
    assert.equal(read.values['retry.enabled'], false)
    // 默认模型的选项是当前 provider 的模型；TUI 的项不在里面
    const spec = (key: string) => read.settings.find((s: any) => s.key === key)
    assert.deepEqual(
      spec('defaultModel').options.map((o: any) => o.value),
      ['gate'],
    )
    assert.ok(spec('defaultProvider').options.some((o: any) => o.value === 'anthropic'))
    assert.equal(spec('theme'), undefined)
    assert.equal(spec('httpProxy').effect, 'harness')
    // 内置扩展可以单独启停
    assert.equal(read.values['extensions:builtin:mcp'], true)
    assert.equal(spec('extensions:builtin:mcp').type, 'boolean')
    assert.deepEqual(read.actions, [])
    assert.equal(read.files[0].path, join(h.agentDir, 'settings.json'))

    const written = await c.ok('litch/harness/config/write', {
      harness: 'pi',
      expectedVersion: read.version,
      edits: [
        { key: 'httpProxy', value: 'http://127.0.0.1:9' },
        { key: 'retry.maxRetries', value: 5 },
        { key: 'retry.enabled', value: null },
        { key: 'compaction.enabled', value: false },
        { key: 'defaultThinkingLevel', value: 'high' },
        { key: 'enabledModels', value: ['gate/*', ' '] },
        { key: 'extensions:builtin:mcp', value: false },
      ],
    })
    assert.equal(written.restartRequired, true)
    assert.notEqual(written.version, read.version)
    const settings = await json(join(h.agentDir, 'settings.json'))
    assert.deepEqual(settings, {
      defaultProvider: 'gate',
      defaultModel: 'gate',
      // retry.enabled 删掉了，retry 里还有 maxRetries
      retry: { maxRetries: 5 },
      theme: 'dark',
      someFuture: { nested: 1 },
      httpProxy: 'http://127.0.0.1:9',
      compaction: { enabled: false },
      defaultThinkingLevel: 'high',
      enabledModels: ['gate/*'],
      extensions: ['-builtin:mcp'],
    })
    const again = await c.ok('litch/harness/config/read', { harness: 'pi' })
    assert.equal(again.version, written.version)
    assert.equal(again.values['extensions:builtin:mcp'], false)
    // 删到空的上层对象一并删掉；打开内置扩展写 +builtin:mcp（同 pi config）
    await c.ok('litch/harness/config/write', {
      harness: 'pi',
      expectedVersion: again.version,
      edits: [
        { key: 'retry.maxRetries', value: null },
        { key: 'extensions:builtin:mcp', value: true },
      ],
    })
    const after = await json(join(h.agentDir, 'settings.json'))
    assert.equal(after.retry, undefined)
    assert.deepEqual(after.extensions, ['+builtin:mcp'])

    // 拿旧版本写：versionConflict，文件不动
    const conflict = await failure(c, 'litch/harness/config/write', {
      expectedVersion: read.version,
      edits: [{ key: 'httpProxy', value: 'http://x' }],
    })
    assert.equal(conflict.code, -32000)
    assert.equal(conflict.data.litch, 'versionConflict')
    assert.equal(conflict.data.harness, 'pi')
    const current = (await c.ok('litch/harness/config/read', { harness: 'pi' })).version
    // 一批里有一项不合法：一项都不写
    const bad = await failure(c, 'litch/harness/config/write', {
      expectedVersion: current,
      edits: [
        { key: 'httpProxy', value: 'http://y' },
        { key: 'defaultThinkingLevel', value: 'ultra' },
      ],
    })
    assert.equal(bad.data.litch, 'invalidValue')
    assert.equal(bad.data.key, 'defaultThinkingLevel')
    const missing = await failure(c, 'litch/harness/config/write', {
      expectedVersion: current,
      edits: [{ key: 'theme', value: 'light' }],
    })
    assert.equal(missing.data.litch, 'notFound')
    assert.equal((await json(join(h.agentDir, 'settings.json'))).httpProxy, 'http://127.0.0.1:9')

    // 变化只通知声明了 harnessConfig 的连接
    assert.ok(c.notifications('litch/harness/config/changed').length >= 2)
    assert.deepEqual(c.notifications('litch/harness/config/changed')[0].params, {
      harness: 'pi',
      part: 'config',
    })
    assert.equal(plain.notifications('litch/harness/config/changed').length, 0)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('HC-PI-002：用户级指令文件 AGENTS.md：读写、哈希冲突、软链照着写、override 盖住时说出来', {
  timeout: 60000,
}, async () => {
  const { h, c } = await setup()
  try {
    const empty = await c.ok('litch/harness/instructions/read', { harness: 'pi' })
    assert.deepEqual(empty, {
      path: join(h.agentDir, 'AGENTS.md'),
      fileName: 'AGENTS.md',
      exists: false,
      content: '',
      hash: '',
      linkTarget: null,
      overriddenBy: null,
    })
    const { hash } = await c.ok('litch/harness/instructions/write', {
      harness: 'pi',
      content: '# 规矩\n',
      expectedHash: '',
    })
    const read = await c.ok('litch/harness/instructions/read', { harness: 'pi' })
    assert.equal(read.content, '# 规矩\n')
    assert.equal(read.hash, hash)
    const stale = await failure(c, 'litch/harness/instructions/write', {
      content: 'x',
      expectedHash: '',
    })
    assert.equal(stale.data.litch, 'versionConflict')
    // 统一模式留下的软链：写的是它指向的那份，软链还在
    const shared = join(h.root, 'shared-AGENTS.md')
    await writeFile(shared, '共用\n')
    await import('node:fs/promises').then((fs) => fs.rm(join(h.agentDir, 'AGENTS.md')))
    await symlink(shared, join(h.agentDir, 'AGENTS.md'))
    const linked = await c.ok('litch/harness/instructions/read', { harness: 'pi' })
    assert.equal(linked.content, '共用\n')
    assert.ok(linked.linkTarget?.endsWith('shared-AGENTS.md'))
    await c.ok('litch/harness/instructions/write', {
      harness: 'pi',
      content: '改过\n',
      expectedHash: linked.hash,
    })
    assert.ok((await lstat(join(h.agentDir, 'AGENTS.md'))).isSymbolicLink())
    assert.equal(await readlink(join(h.agentDir, 'AGENTS.md')), shared)
    assert.equal(await readFile(shared, 'utf8'), '改过\n')
    await writeFile(join(h.agentDir, 'AGENTS.override.md'), '盖住\n')
    assert.equal(
      (await c.ok('litch/harness/instructions/read', { harness: 'pi' })).overriddenBy,
      join(h.agentDir, 'AGENTS.override.md'),
    )
    assert.deepEqual(c.notifications('litch/harness/config/changed').at(-1).params, {
      harness: 'pi',
      part: 'instructions',
    })
  } finally {
    await h.dispose()
  }
})

test('HC-PI-003：provider：内置与自定义、models.json 的增改删、切换当前在用的', {
  timeout: 60000,
}, async () => {
  const { h, c } = await setup()
  try {
    const read = await c.ok('litch/harness/providers/read', { harness: 'pi' })
    assert.equal(read.switchable, true)
    assert.deepEqual(
      read.templates.map((template: any) => template.id),
      ['compatible'],
    )
    const find = (list: any, id: string) => list.providers.find((p: any) => p.id === id)
    const gate = find(read, 'gate')
    assert.equal(gate.kind, 'custom')
    assert.equal(gate.active, true)
    assert.equal(gate.templateId, 'compatible')
    assert.deepEqual(gate.definition.apiKey, { set: true })
    assert.deepEqual(gate.definition.models, ['gate'])
    assert.deepEqual(gate.auth, {
      signedIn: true,
      kind: 'apiKey',
      label: 'models.json',
      detail: { 'zh-CN': 'key 写在 models.json 里', en: 'The key is in models.json' },
    })
    const anthropic = find(read, 'anthropic')
    assert.equal(anthropic.kind, 'builtin')
    assert.equal(anthropic.active, false)
    assert.deepEqual(
      anthropic.methods.map((m: any) => [m.id, m.kind]),
      [
        ['oauth', 'oauthBrowser'],
        ['api_key', 'apiKey'],
      ],
    )
    assert.equal(find(read, 'github-copilot').methods[0].kind, 'oauthDeviceCode')

    // 新增一个兼容接口；和内置重名的不收
    const clash = await failure(c, 'litch/harness/providers/upsert', {
      providerId: 'anthropic',
      templateId: 'compatible',
      definition: { baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] },
      expectedVersion: read.version,
    })
    assert.equal(clash.data.litch, 'invalidValue')
    const added = await c.ok('litch/harness/providers/upsert', {
      harness: 'pi',
      providerId: 'local',
      templateId: 'compatible',
      definition: {
        name: '本地',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'fake-local-key',
        models: ['qwen', 'llama'],
        headers: ['X-Team: litch'],
      },
      expectedVersion: read.version,
    })
    // 改的时候不给 key：key 不动；gate 那一项的模型描述原样留着
    await c.ok('litch/harness/providers/upsert', {
      harness: 'pi',
      providerId: 'local',
      templateId: 'compatible',
      definition: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen'], authHeader: true },
      expectedVersion: added.version,
    })
    const models = await json(join(h.agentDir, 'models.json'))
    assert.deepEqual(models.providers.local, {
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'fake-local-key',
      models: [{ id: 'qwen' }],
      headers: { 'X-Team': 'litch' },
      authHeader: true,
    })
    assert.equal(models.providers.gate.models[0].contextWindow, 32000)
    const listed = await c.ok('litch/harness/providers/read', { harness: 'pi' })
    assert.equal(find(listed, 'local').kind, 'custom')
    assert.deepEqual(find(listed, 'local').definition.headers, ['X-Team: litch'])

    // 切到 anthropic：默认模型换成这家有的
    const activated = await c.ok('litch/harness/providers/activate', {
      harness: 'pi',
      providerId: 'anthropic',
      expectedVersion: listed.version,
    })
    const settings = await json(join(h.agentDir, 'settings.json'))
    assert.equal(settings.defaultProvider, 'anthropic')
    assert.notEqual(settings.defaultModel, 'gate')
    assert.equal(settings.theme, 'dark')
    const config = await c.ok('config/read', { cwd: h.cwd })
    assert.equal(config.config.model, `anthropic/${settings.defaultModel}`)
    const stale = await failure(c, 'litch/harness/providers/activate', {
      providerId: 'gate',
      expectedVersion: listed.version,
    })
    assert.equal(stale.data.litch, 'versionConflict')
    // 切回 gate：它的模型里没有 anthropic 的那个，换成 gate
    await c.ok('litch/harness/providers/activate', {
      harness: 'pi',
      providerId: 'gate',
      expectedVersion: activated.version,
    })
    assert.equal((await json(join(h.agentDir, 'settings.json'))).defaultModel, 'gate')

    await c.ok('litch/harness/providers/remove', { harness: 'pi', providerId: 'local' })
    assert.equal((await json(join(h.agentDir, 'models.json'))).providers.local, undefined)
    const gone = await failure(c, 'litch/harness/providers/remove', { providerId: 'anthropic' })
    assert.equal(gone.data.litch, 'notFound')
  } finally {
    await h.dispose()
  }
})

test('HC-PI-004：API key 登录存进临时目录的 auth.json，要的别的信息接着问；登出清掉', {
  timeout: 60000,
}, async () => {
  const { h, c } = await setup()
  try {
    const started = await c.ok('litch/harness/auth/start', {
      harness: 'pi',
      providerId: 'anthropic',
      methodId: 'api_key',
      inputs: { key: 'sk-ant-fake-1234' },
    })
    assert.equal(started.step.kind, 'done')
    assert.deepEqual(started.step.auth, { signedIn: true, kind: 'apiKey', label: '…1234' })
    const auth = await json(join(h.agentDir, 'auth.json'))
    assert.deepEqual(auth.anthropic, { type: 'api_key', key: 'sk-ant-fake-1234' })
    let read = await c.ok('litch/harness/providers/read', { harness: 'pi' })
    assert.equal(read.providers.find((p: any) => p.id === 'anthropic').canLogout, true)
    // 已有默认 provider：登录不改它
    assert.equal((await json(join(h.agentDir, 'settings.json'))).defaultProvider, 'gate')

    // Cloudflare 还要账号 ID：key 先交了，下一步问账号 ID
    const cloudflare = await c.ok('litch/harness/auth/start', {
      harness: 'pi',
      providerId: 'cloudflare-workers-ai',
      methodId: 'api_key',
      inputs: { key: 'cf-fake-key' },
    })
    assert.equal(cloudflare.step.kind, 'prompt')
    assert.equal(cloudflare.step.fields.length, 1)
    assert.match(cloudflare.step.fields[0].title.en, /account ID/)
    const done = await c.ok('litch/harness/auth/continue', {
      harness: 'pi',
      attemptId: cloudflare.attemptId,
      inputs: { [cloudflare.step.fields[0].id]: 'acct-1' },
    })
    assert.equal(done.kind, 'done')
    assert.deepEqual((await json(join(h.agentDir, 'auth.json')))['cloudflare-workers-ai'], {
      type: 'api_key',
      key: 'cf-fake-key',
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
    })

    // 不给 key：流程自己问
    const asked = await c.ok('litch/harness/auth/start', {
      harness: 'pi',
      providerId: 'deepseek',
      methodId: 'api_key',
    })
    assert.equal(asked.step.kind, 'prompt')
    assert.equal(asked.step.fields[0].secret, true)
    const empty = await failure(c, 'litch/harness/auth/continue', {
      attemptId: asked.attemptId,
      inputs: {},
    })
    assert.equal(empty.data.litch, 'invalidValue')
    await c.ok('litch/harness/auth/cancel', { harness: 'pi', attemptId: asked.attemptId })
    const cancelled = await c.until(
      '取消后的通知',
      (m: any) =>
        m.method === 'litch/harness/auth/updated' && m.params.attemptId === asked.attemptId,
    )
    assert.equal(cancelled.params.step.kind, 'failed')
    assert.equal(cancelled.params.providerId, 'deepseek')

    await c.ok('litch/harness/auth/logout', { harness: 'pi', providerId: 'anthropic' })
    assert.equal((await json(join(h.agentDir, 'auth.json'))).anthropic, undefined)
    read = await c.ok('litch/harness/providers/read', { harness: 'pi' })
    assert.equal(read.providers.find((p: any) => p.id === 'anthropic').canLogout, false)
    const unknown = await failure(c, 'litch/harness/auth/continue', {
      attemptId: 'nope',
      inputs: {},
    })
    assert.equal(unknown.data.litch, 'notFound')
  } finally {
    await h.dispose()
  }
})

test('HC-PI-005：OAuth 只走到拿到授权链接：浏览器授权带回调端口和粘贴框，先选方式的先问方式；取消后通知失败', {
  timeout: 60000,
}, async () => {
  const { h, c, plain } = await setup()
  try {
    const anthropic = await c.ok('litch/harness/auth/start', {
      harness: 'pi',
      providerId: 'anthropic',
      methodId: 'oauth',
    })
    assert.equal(anthropic.step.kind, 'openUrl')
    const url = new URL(anthropic.step.url)
    assert.equal(
      anthropic.step.callbackPort,
      Number(new URL(url.searchParams.get('redirect_uri')!).port),
    )
    assert.ok(anthropic.step.callbackPort > 0)
    // 浏览器不在设备上时把授权码粘贴回来
    assert.deepEqual(
      anthropic.step.prompt.map((field: any) => [field.id, field.secret]),
      [['code', false]],
    )
    await c.ok('litch/harness/auth/cancel', { harness: 'pi', attemptId: anthropic.attemptId })
    const failed = await c.until(
      '取消后的通知',
      (m: any) =>
        m.method === 'litch/harness/auth/updated' && m.params.attemptId === anthropic.attemptId,
    )
    assert.equal(failed.params.step.kind, 'failed')
    assert.equal(plain.notifications('litch/harness/auth/updated').length, 0)

    // ChatGPT（旧的 Codex 登录）先问用浏览器还是设备码
    const codex = await c.ok('litch/harness/auth/start', {
      harness: 'pi',
      providerId: 'openai-codex',
      methodId: 'oauth',
    })
    assert.equal(codex.step.kind, 'prompt')
    const choice = codex.step.fields[0]
    assert.ok(choice.options.length >= 2)
    const browser = await c.ok('litch/harness/auth/continue', {
      harness: 'pi',
      attemptId: codex.attemptId,
      inputs: { [choice.id]: choice.options[0].value },
    })
    assert.equal(browser.kind, 'openUrl')
    assert.match(browser.url, /^https:\/\//)
    await c.ok('litch/harness/auth/cancel', { harness: 'pi', attemptId: codex.attemptId })
    await c.until(
      '取消后的通知',
      (m: any) =>
        m.method === 'litch/harness/auth/updated' && m.params.attemptId === codex.attemptId,
    )
    // 没登录上，auth.json 里什么都没有
    await pause(50)
    assert.deepEqual(await json(join(h.agentDir, 'auth.json')).catch(() => ({})), {})
  } finally {
    await h.dispose()
  }
})

test('HC-PI-006：MCP 读写 mcp.json：两种传输、Bearer 环境变量、密钥不读回也不丢、改名、删除', {
  timeout: 60000,
}, async () => {
  const { h, c } = await setup()
  try {
    await writeFile(
      join(h.agentDir, 'mcp.json'),
      `${JSON.stringify(
        {
          autoEnableCodemode: false,
          mcpServers: {
            files: {
              command: 'npx',
              args: ['-y', 'server-files'],
              env: { API_KEY: 'literal-secret', HOME_DIR: '/tmp', TOKEN: '${FROM_ENV}' },
              exposure: 'direct',
            },
          },
        },
        null,
        4,
      )}\n`,
    )
    const read = await c.ok('litch/harness/mcp/read', { harness: 'pi' })
    assert.deepEqual(read.transports, ['stdio', 'http'])
    assert.equal(read.oauth, true)
    assert.deepEqual(read.servers, [
      {
        name: 'files',
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', 'server-files'],
        // 字面量的密钥读到空串；引用环境变量的照给
        env: { API_KEY: '', HOME_DIR: '/tmp', TOKEN: '${FROM_ENV}' },
        secretKeys: ['API_KEY'],
        extra: { exposure: 'direct' },
        status: null,
      },
    ])
    // 改名、停用，密钥原样交回（空串）：原来的值留着
    const renamed = await c.ok('litch/harness/mcp/upsert', {
      harness: 'pi',
      previousName: 'files',
      server: { ...read.servers[0], name: 'files2', enabled: false, status: undefined },
      expectedVersion: read.version,
    })
    const docs = await c.ok('litch/harness/mcp/upsert', {
      harness: 'pi',
      server: {
        name: 'docs',
        transport: 'http',
        enabled: true,
        url: 'https://example.com/mcp',
        bearerTokenEnvVar: 'DOCS_TOKEN',
        extra: { timeout: 30 },
      },
      expectedVersion: renamed.version,
    })
    const text = await readFile(join(h.agentDir, 'mcp.json'), 'utf8')
    // Pi 改这份文件时留着原来的缩进和别的键
    assert.match(text, /^\{\n {4}"autoEnableCodemode": false/)
    const file = JSON.parse(text)
    assert.deepEqual(file.mcpServers, {
      files2: {
        exposure: 'direct',
        command: 'npx',
        args: ['-y', 'server-files'],
        env: { API_KEY: 'literal-secret', HOME_DIR: '/tmp', TOKEN: '${FROM_ENV}' },
        enabled: false,
      },
      docs: {
        timeout: 30,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
      },
    })
    const again = await c.ok('litch/harness/mcp/read', { harness: 'pi' })
    assert.equal(again.version, docs.version)
    const http = again.servers.find((s: any) => s.name === 'docs')
    assert.equal(http.bearerTokenEnvVar, 'DOCS_TOKEN')
    assert.equal(http.headers, undefined)
    assert.deepEqual(again.servers.find((s: any) => s.name === 'files2').status, {
      state: 'disabled',
      message: null,
    })
    const sse = await failure(c, 'litch/harness/mcp/upsert', {
      server: { name: 'old', transport: 'sse', enabled: true, url: 'https://example.com/sse' },
      expectedVersion: again.version,
    })
    assert.equal(sse.data.litch, 'invalidValue')
    const stale = await failure(c, 'litch/harness/mcp/remove', {
      name: 'docs',
      expectedVersion: read.version,
    })
    assert.equal(stale.data.litch, 'versionConflict')
    await c.ok('litch/harness/mcp/remove', {
      harness: 'pi',
      name: 'docs',
      expectedVersion: again.version,
    })
    assert.deepEqual(Object.keys((await json(join(h.agentDir, 'mcp.json'))).mcpServers), ['files2'])
    assert.deepEqual(c.notifications('litch/harness/config/changed').at(-1).params, {
      harness: 'pi',
      part: 'mcp',
    })
  } finally {
    await h.dispose()
  }
})

/** 回环上一个要 OAuth 的 MCP 服务：受保护资源与授权服务的元数据、动态注册，其余一律 401 */
async function oauthServer() {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const base = `http://127.0.0.1:${(server.address() as any).port}`
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const path = new URL(req.url ?? '/', base).pathname
    if (path.startsWith('/.well-known/oauth-protected-resource'))
      return send(200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (
      path.startsWith('/.well-known/oauth-authorization-server') ||
      path.startsWith('/.well-known/openid-configuration')
    )
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
    if (path === '/register') return send(201, { client_id: 'fake-client', redirect_uris: [] })
    send(
      401,
      { error: 'unauthorized' },
      {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('HC-PI-007：MCP 登录照 pi mcp login：要登录的走到授权链接（带回调端口和粘贴框），取消后通知失败；stdio 的不用 OAuth', {
  timeout: 60000,
}, async () => {
  const fake = await oauthServer()
  const { h, c } = await setup()
  try {
    await writeFile(
      join(h.agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { guarded: { url: fake.url }, local: { command: 'true' } },
      }),
    )
    const started = await c.ok('litch/harness/mcp/login', { harness: 'pi', name: 'guarded' })
    assert.equal(started.step.kind, 'openUrl')
    const url = new URL(started.step.url)
    assert.equal(url.searchParams.get('client_id'), 'fake-client')
    assert.equal(
      started.step.callbackPort,
      Number(new URL(url.searchParams.get('redirect_uri')!).port),
    )
    assert.deepEqual(
      started.step.prompt.map((field: any) => field.id),
      ['redirectUrl'],
    )
    await c.ok('litch/harness/auth/cancel', { harness: 'pi', attemptId: started.attemptId })
    const failed = await c.until(
      '取消后的通知',
      (m: any) =>
        m.method === 'litch/harness/auth/updated' && m.params.attemptId === started.attemptId,
    )
    assert.equal(failed.params.mcpServer, 'guarded')
    assert.equal(failed.params.step.kind, 'failed')
    const stdio = await failure(c, 'litch/harness/mcp/login', { name: 'local' })
    assert.equal(stdio.data.litch, 'invalidValue')
    const missing = await failure(c, 'litch/harness/mcp/login', { name: 'nope' })
    assert.equal(missing.data.litch, 'notFound')
  } finally {
    await h.dispose()
    await fake.close()
  }
})
