import assert from 'node:assert/strict'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ClaudeLoginAttempt, claudeAuthStatus } from '../src/claude-auth.mjs'
import { migrateDefaultModel, readSettingsDefaults } from '../src/claude-default-model.mjs'
import {
  ACCOUNT_PROVIDER,
  API_KEY_PROVIDER,
  applyProviderEnv,
  claudeChildEnv,
  gatewayTokenEnv,
  readProviderSelection,
} from '../src/claude-provider.mjs'
import {
  readClaudeConfig,
  readClaudeInstructions,
  readClaudeMcp,
  removeClaudeMcp,
  upsertClaudeMcp,
  writeClaudeConfig,
  writeClaudeInstructions,
} from '../src/harness-config.mjs'
import { HarnessConfigError } from '../src/harness-config-common.mjs'
import { ClaudeProviders } from '../src/harness-providers.mjs'
import { requiredClaudeCli } from './fixtures/claude-cli.mjs'
import { declaring } from './fixtures/extension-wire.mjs'
import { OAuthMcpFixture } from './fixtures/mcp-oauth.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const fakeCli = fileURLToPath(
  new URL('../../../test/fixtures/fake-claude-auth.mjs', import.meta.url),
)

const CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'LITCH_CLAUDE_API_KEY',
  'LITCH_CLAUDE_OAUTH_TOKEN',
]

// 每个用例自己的 Claude 配置目录和适配器目录：只设这几个变量，用完复原，绝不碰真实的 ~/.claude
async function isolated(
  run: (paths: { root: string; claude: string; adapter: string }) => Promise<void> | void,
  extra: Record<string, string> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'harness-config-'))
  const claude = join(root, 'claude')
  const adapter = join(root, 'adapter')
  await mkdir(claude, { recursive: true })
  const vars: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claude,
    CHA_CLAUDE_HOME: adapter,
    ...extra,
  }
  // CHA_CLAUDE_CLI 用例里可能会改（换成假 CLI），一并复原；跑测试的人环境里的模型凭据先拿掉
  const previous = Object.fromEntries(
    [...Object.keys(vars), 'CHA_CLAUDE_CLI', ...CREDENTIAL_ENV].map((name) => [
      name,
      process.env[name],
    ]),
  )
  for (const name of CREDENTIAL_ENV) delete process.env[name]
  Object.assign(process.env, vars)
  try {
    await run({ root, claude, adapter })
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    await rm(root, { recursive: true, force: true })
  }
}

function reason(error: unknown): string | undefined {
  return error instanceof HarnessConfigError ? error.data.litch : undefined
}

async function rejectsWith(run: () => unknown, expected: string): Promise<HarnessConfigError> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  assert.equal(reason(caught), expected, String(caught))
  return caught as HarnessConfigError
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

test('HC-CLAUDE-001：settings.json 的配置项读写，保留认不出的键，hooks 只读，全写或全不写', () =>
  isolated(async ({ claude }) => {
    const settingsPath = join(claude, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        someFutureKey: { nested: [1, 2] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] },
        enabledPlugins: { 'fmt@tools': true },
        attribution: false,
      }),
    )
    await mkdir(join(claude, 'plugins'))
    await writeFile(
      join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'other@market': [{ scope: 'user' }] } }),
    )
    const first = readClaudeConfig([])
    const keys = first.settings.map((item) => item.key)
    for (const key of [
      'model',
      'effortLevel',
      'fastMode',
      'alwaysThinkingEnabled',
      'outputStyle',
      'permissions.defaultMode',
      'permissions.allow',
      'permissions.ask',
      'permissions.deny',
      'language',
      'attribution.commit',
      'attribution.pr',
      'autoCompactEnabled',
      'autoMemoryEnabled',
      'cleanupPeriodDays',
      'autoUpdatesChannel',
      'extraKnownMarketplaces',
      'hooks',
      'enabledPlugins."fmt@tools"',
      'enabledPlugins."other@market"',
    ])
      assert.ok(keys.includes(key), key)
    assert.equal(first.values['enabledPlugins."fmt@tools"'], true)
    assert.equal(first.values['enabledPlugins."other@market"'], undefined)
    assert.ok(first.values.hooks)
    assert.equal(first.settings.find((item) => item.key === 'hooks')?.readOnly, true)
    assert.deepEqual(
      first.files.find((file) => file.role === 'settings'),
      { role: 'settings', path: settingsPath },
    )

    const written = writeClaudeConfig(
      [
        { key: 'model', value: 'opus' },
        { key: 'effortLevel', value: 'high' },
        { key: 'permissions.allow', value: ['Bash(npm test:*)', '  '] },
        { key: 'enabledPlugins."other@market"', value: true },
        { key: 'attribution.commit', value: '' },
        { key: 'language', value: null },
        { key: 'cleanupPeriodDays', value: 7 },
      ],
      first.version,
      [],
    )
    assert.equal(written.defaultsChanged, true)
    assert.equal(written.restartRequired, false)
    assert.notEqual(written.version, first.version)
    const saved = await readJson(settingsPath)
    assert.deepEqual(saved.someFutureKey, { nested: [1, 2] })
    assert.equal(saved.model, 'opus')
    assert.equal(saved.effortLevel, 'high')
    assert.deepEqual(saved.permissions, { allow: ['Bash(npm test:*)'] })
    assert.deepEqual(saved.enabledPlugins, { 'fmt@tools': true, 'other@market': true })
    assert.deepEqual(saved.attribution, { commit: '' })
    assert.equal(saved.cleanupPeriodDays, 7)
    assert.ok(saved.hooks.PreToolUse)
    assert.equal(readClaudeConfig([]).version, written.version)

    // 旧版本号、只读、不认识的键、不合法的值都整个拒绝，文件不动
    const before = await readFile(settingsPath, 'utf8')
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'fastMode', value: true }], first.version, []),
      'versionConflict',
    )
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'hooks', value: {} }], written.version, []),
      'readOnly',
    )
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'nope', value: 1 }], written.version, []),
      'notFound',
    )
    const bad = await rejectsWith(
      () =>
        writeClaudeConfig(
          [
            { key: 'fastMode', value: true },
            { key: 'effortLevel', value: 'max' },
          ],
          written.version,
          [],
        ),
      'invalidValue',
    )
    assert.equal(bad.data.key, 'effortLevel')
    assert.equal(bad.data.harness, 'claude-code')
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'cleanupPeriodDays', value: 0 }], written.version, []),
      'invalidValue',
    )
    assert.equal(await readFile(settingsPath, 'utf8'), before)

    // “默认”模型就是不写；删空的父对象一起删掉
    const cleared = writeClaudeConfig(
      [
        { key: 'model', value: 'default' },
        { key: 'permissions.allow', value: null },
      ],
      written.version,
      [],
    )
    const after = await readJson(settingsPath)
    assert.equal(after.model, undefined)
    assert.equal(after.permissions, undefined)
    assert.equal(readClaudeConfig([]).version, cleared.version)
  }))

test('HC-CLAUDE-002：settings.json 是软链时写到它指向的文件', () =>
  isolated(async ({ root, claude }) => {
    const real = join(root, 'dotfiles-settings.json')
    await writeFile(real, '{"keep": 1}\n')
    await symlink(real, join(claude, 'settings.json'))
    const { version } = readClaudeConfig([])
    writeClaudeConfig([{ key: 'autoMemoryEnabled', value: false }], version, [])
    assert.ok((await lstat(join(claude, 'settings.json'))).isSymbolicLink())
    assert.deepEqual(await readJson(real), { keep: 1, autoMemoryEnabled: false })
  }))

test('HC-CLAUDE-003：用户级 MCP 读写 ~/.claude.json 的 mcpServers，文件其余部分和认不出的服务原样保留', () =>
  isolated(async ({ claude }) => {
    const path = join(claude, '.claude.json')
    await writeFile(
      path,
      JSON.stringify({
        numStartups: 42,
        projects: { '/x': { allowedTools: [] } },
        mcpServers: {
          local: {
            type: 'stdio',
            command: 'node',
            args: ['s.mjs'],
            env: { API_KEY: 's3cret', PLAIN: 'v' },
          },
          socket: { type: 'ws', url: 'ws://127.0.0.1:9' },
        },
      }),
      { mode: 0o600 },
    )
    const first = readClaudeMcp()
    assert.deepEqual(first.transports, ['stdio', 'http', 'sse'])
    assert.equal(first.oauth, true)
    assert.deepEqual(
      first.servers.map((server) => server.name),
      ['local'],
      'ws 这类表单画不了的不列出来',
    )
    const local = first.servers[0]!
    assert.equal(local.transport, 'stdio')
    assert.deepEqual(local.env, { API_KEY: '', PLAIN: 'v' })
    assert.deepEqual(local.secretKeys, ['API_KEY'])

    // 密钥不给表示不改；新增 http 的；改名；删掉
    let version = upsertClaudeMcp({
      server: {
        name: 'local',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['s2.mjs'],
        env: { PLAIN: 'v2' },
      },
      expectedVersion: first.version,
    }).version
    version = upsertClaudeMcp({
      server: {
        name: 'docs',
        transport: 'http',
        enabled: true,
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: 'Bearer t0k' },
        extra: { timeout: 5000 },
      },
      expectedVersion: version,
    }).version
    let saved = await readJson(path)
    assert.deepEqual(saved.mcpServers.local, {
      type: 'stdio',
      command: 'node',
      args: ['s2.mjs'],
      env: { PLAIN: 'v2', API_KEY: 's3cret' },
    })
    assert.deepEqual(saved.mcpServers.docs, {
      timeout: 5000,
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer t0k' },
    })
    const docs = readClaudeMcp().servers.find((server) => server.name === 'docs')!
    assert.deepEqual(docs.headers, { Authorization: '' })
    assert.deepEqual(docs.extra, { timeout: 5000 })
    version = upsertClaudeMcp({
      previousName: 'docs',
      server: { ...docs, name: 'docs2', headers: {} },
      expectedVersion: version,
    }).version
    saved = await readJson(path)
    assert.equal(saved.mcpServers.docs, undefined)
    assert.deepEqual(
      saved.mcpServers.docs2.headers,
      { Authorization: 'Bearer t0k' },
      '改名也不丢密钥',
    )
    await rejectsWith(
      () => removeClaudeMcp({ name: 'docs2', expectedVersion: first.version }),
      'versionConflict',
    )
    await rejectsWith(
      () =>
        upsertClaudeMcp({
          server: { name: 'x', transport: 'stdio', enabled: false, command: 'a' },
          expectedVersion: version,
        }),
      'invalidValue',
    )
    await rejectsWith(
      () =>
        upsertClaudeMcp({
          server: { name: 'x', transport: 'http', enabled: true, url: 'file:///etc' },
          expectedVersion: version,
        }),
      'invalidValue',
    )
    await rejectsWith(
      () =>
        upsertClaudeMcp({
          server: { name: 'a b', transport: 'stdio', enabled: true, command: 'a' },
          expectedVersion: version,
        }),
      'invalidValue',
    )
    removeClaudeMcp({ name: 'docs2', expectedVersion: version })
    saved = await readJson(path)
    assert.equal(saved.numStartups, 42)
    assert.deepEqual(saved.projects, { '/x': { allowedTools: [] } })
    assert.deepEqual(saved.mcpServers.socket, { type: 'ws', url: 'ws://127.0.0.1:9' })
    assert.deepEqual(Object.keys(saved.mcpServers).sort(), ['local', 'socket'])
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }))

test('HC-CLAUDE-004：CLAUDE.md 读写带哈希，软链（统一模式）写到指向的文件', () =>
  isolated(async ({ root, claude }) => {
    const missing = readClaudeInstructions()
    assert.equal(missing.path, join(claude, 'CLAUDE.md'))
    assert.equal(missing.fileName, 'CLAUDE.md')
    assert.equal(missing.exists, false)
    assert.equal(missing.hash, '')
    assert.equal(missing.linkTarget, null)
    const { hash } = writeClaudeInstructions({ content: '# 规矩\n', expectedHash: '' })
    assert.equal(await readFile(join(claude, 'CLAUDE.md'), 'utf8'), '# 规矩\n')
    assert.equal(readClaudeInstructions().hash, hash)
    await rejectsWith(
      () => writeClaudeInstructions({ content: 'x', expectedHash: '' }),
      'versionConflict',
    )

    const source = join(root, 'AGENTS.md')
    await writeFile(source, 'shared\n')
    await rm(join(claude, 'CLAUDE.md'))
    await symlink(source, join(claude, 'CLAUDE.md'))
    const linked = readClaudeInstructions()
    assert.equal(linked.content, 'shared\n')
    assert.equal(linked.linkTarget, await import('node:fs').then((fs) => fs.realpathSync(source)))
    writeClaudeInstructions({ content: 'shared v2\n', expectedHash: linked.hash })
    assert.ok((await lstat(join(claude, 'CLAUDE.md'))).isSymbolicLink())
    assert.equal(await readFile(source, 'utf8'), 'shared v2\n')
  }))

test('HC-CLAUDE-005：默认模型从适配器的 config.json 搬到 settings.json，已有的不覆盖', () =>
  isolated(async ({ claude, adapter }) => {
    await mkdir(adapter, { recursive: true })
    const configPath = join(adapter, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        model: 'sonnet[1m]',
        model_reasoning_effort: 'minimal',
        overrides: { sandbox_mode: 'read-only' },
      }),
    )
    await writeFile(join(claude, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    assert.equal(migrateDefaultModel(configPath), true)
    assert.deepEqual(await readJson(join(claude, 'settings.json')), {
      theme: 'dark',
      model: 'sonnet[1m]',
      effortLevel: 'low',
    })
    assert.deepEqual(await readJson(configPath), { overrides: { sandbox_mode: 'read-only' } })
    assert.equal(migrateDefaultModel(configPath), false, '搬过一次就不再搬')
    assert.deepEqual(readSettingsDefaults(), { model: 'sonnet[1m]', effort: 'low' })

    await writeFile(configPath, JSON.stringify({ model: 'haiku', overrides: {} }))
    assert.equal(migrateDefaultModel(configPath), true)
    assert.equal(
      (await readJson(join(claude, 'settings.json'))).model,
      'sonnet[1m]',
      'settings.json 里已有的不覆盖',
    )
    assert.equal((await readJson(configPath)).model, undefined)
  }))

test('HC-CLAUDE-006：按选的 provider 改写给 CLI 的环境，LITCH_ 的密钥不传下去', () => {
  const base = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'from-device-env',
    ANTHROPIC_BASE_URL: 'https://old.example.test',
    LITCH_CLAUDE_API_KEY: 'sk-ant-api-litch',
    LITCH_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat-litch',
    [gatewayTokenEnv('corp-gw')]: 'gw-token',
  }
  const selection = {
    active: null,
    gateways: {
      'corp-gw': { title: null, baseUrl: 'https://gw.example.test', authHeader: 'bearer' as const },
    },
  }
  assert.equal(gatewayTokenEnv('corp-gw'), 'LITCH_CLAUDE_GATEWAY_CORP_GW_TOKEN')
  // 没选过：除了去掉 LITCH_ 的密钥，原样
  assert.deepEqual(applyProviderEnv(base, selection), {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'from-device-env',
    ANTHROPIC_BASE_URL: 'https://old.example.test',
  })
  assert.deepEqual(applyProviderEnv(base, { ...selection, active: ACCOUNT_PROVIDER }), {
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-litch',
  })
  assert.deepEqual(
    applyProviderEnv(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'x' },
      { ...selection, active: ACCOUNT_PROVIDER },
    ),
    {
      PATH: '/bin',
    },
  )
  assert.deepEqual(applyProviderEnv(base, { ...selection, active: API_KEY_PROVIDER }), {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk-ant-api-litch',
  })
  assert.deepEqual(applyProviderEnv(base, { ...selection, active: 'corp-gw' }), {
    PATH: '/bin',
    ANTHROPIC_AUTH_TOKEN: 'gw-token',
    ANTHROPIC_BASE_URL: 'https://gw.example.test',
  })
  const apiKeyHeader = {
    active: 'corp-gw',
    gateways: { 'corp-gw': { ...selection.gateways['corp-gw'], authHeader: 'apiKey' as const } },
  }
  assert.deepEqual(applyProviderEnv(base, apiKeyHeader), {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'gw-token',
    ANTHROPIC_BASE_URL: 'https://gw.example.test',
  })
})

// 假 CLI 拷进用例的临时目录再用：只认 auth 子命令，状态记在配置目录里，不碰钥匙串
async function withFakeCli(root: string): Promise<string> {
  const cli = join(root, 'fake-claude.mjs')
  await copyFile(fakeCli, cli)
  await chmod(cli, 0o755)
  return cli
}

async function calls(claude: string): Promise<any[]> {
  return (await readFile(join(claude, 'fake-calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

test('HC-CLAUDE-007：provider 三选一、自定义网关、切换不丢 key', () =>
  isolated(
    async ({ root, claude }) => {
      process.env.CHA_CLAUDE_CLI = await withFakeCli(root)
      const events: Array<{ method: string; params: any }> = []
      const providers = new ClaudeProviders({
        broadcast: (method, params) => events.push({ method, params }),
      })
      let read = await providers.read()
      assert.equal(read.switchable, true)
      assert.deepEqual(
        read.providers.map((provider) => [provider.id, provider.active]),
        [
          ['anthropic', true],
          ['api-key', false],
        ],
      )
      const account = read.providers[0]!
      assert.deepEqual(account.auth, { signedIn: false, kind: 'none', label: null })
      assert.deepEqual(
        account.methods.map((method) => [method.id, method.kind, method.envName ?? null]),
        [
          ['claudeai', 'oauthPaste', null],
          ['console', 'oauthPaste', null],
          ['oauthToken', 'env', 'LITCH_CLAUDE_OAUTH_TOKEN'],
        ],
      )
      const apiKey = read.providers[1]!
      assert.deepEqual(apiKey.auth, { signedIn: true, kind: 'env', label: '…7890' })
      assert.equal(apiKey.methods[0]!.envName, 'LITCH_CLAUDE_API_KEY')
      assert.equal(apiKey.methods[0]!.effect, 'harness')
      assert.deepEqual(
        read.templates.map((template) => template.id),
        ['anthropicGateway'],
      )

      let version = providers.upsert({
        providerId: 'corp',
        templateId: 'anthropicGateway',
        definition: { title: '公司网关', baseUrl: 'https://gw.example.test/v1' },
        expectedVersion: read.version,
      }).version
      await rejectsWith(
        () => providers.activate({ providerId: 'api-key', expectedVersion: read.version }),
        'versionConflict',
      )
      await rejectsWith(
        () =>
          providers.upsert({
            providerId: 'api-key',
            templateId: 'anthropicGateway',
            definition: {},
            expectedVersion: version,
          }),
        'readOnly',
      )
      await rejectsWith(
        () =>
          providers.upsert({
            providerId: 'bad',
            templateId: 'anthropicGateway',
            definition: { baseUrl: 'ftp://x' },
            expectedVersion: version,
          }),
        'invalidValue',
      )
      version = providers.activate({ providerId: 'corp', expectedVersion: version }).version
      read = await providers.read()
      const corp = read.providers.find((provider) => provider.id === 'corp')!
      assert.equal(corp.kind, 'custom')
      assert.equal(corp.active, true)
      assert.equal(corp.templateId, 'anthropicGateway')
      assert.deepEqual(corp.definition, {
        title: '公司网关',
        baseUrl: 'https://gw.example.test/v1',
        authHeader: 'bearer',
      })
      assert.equal(corp.methods[0]!.envName, 'LITCH_CLAUDE_GATEWAY_CORP_TOKEN')
      assert.deepEqual(corp.auth, { signedIn: false, kind: 'none', label: null })
      let env = claudeChildEnv()
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.example.test/v1')
      assert.equal(env.ANTHROPIC_API_KEY, undefined)
      assert.equal(env.LITCH_CLAUDE_API_KEY, undefined)

      version = providers.activate({ providerId: 'api-key', expectedVersion: read.version }).version
      env = claudeChildEnv()
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api-test-1234567890')
      assert.equal(env.ANTHROPIC_BASE_URL, undefined)
      assert.ok(readProviderSelection().gateways.corp, '切走了网关定义还在')

      version = providers.activate({ providerId: 'corp', expectedVersion: version }).version
      providers.remove({ providerId: 'corp', expectedVersion: version })
      assert.equal(readProviderSelection().active, 'anthropic', '删掉正在用的退回账号')
      assert.ok(events.every((event) => event.method === 'litch/harness/config/changed'))
      assert.ok(
        events.every(
          (event) => event.params.harness === 'claude-code' && event.params.part === 'providers',
        ),
      )
      await rejectsWith(() => providers.authLogout({ providerId: 'api-key' }), 'readOnly')
      assert.deepEqual(
        await calls(claude).then((list) => list.every((call) => call.args[1] === 'status')),
        true,
      )
    },
    { LITCH_CLAUDE_API_KEY: 'sk-ant-api-test-1234567890' },
  ))

test('HC-CLAUDE-008：Anthropic 账号的粘贴码登录、取消、登出（假 CLI）', () =>
  isolated(
    async ({ root, claude }) => {
      process.env.CHA_CLAUDE_CLI = await withFakeCli(root)
      const events: Array<{ method: string; params: any }> = []
      const providers = new ClaudeProviders({
        broadcast: (method, params) => events.push({ method, params }),
      })
      try {
        await rejectsWith(
          () => providers.authStart({ providerId: 'api-key', methodId: 'apiKey' }),
          'invalidValue',
        )
        const started = await providers.authStart({ providerId: 'anthropic', methodId: 'claudeai' })
        assert.equal(started.step.kind, 'openUrl')
        if (started.step.kind !== 'openUrl') return
        assert.equal(
          started.step.url,
          'https://auth.example.test/oauth/authorize?code=true&mode=claudeai&state=abc',
        )
        assert.equal(started.step.callbackPort, null)
        assert.deepEqual(
          started.step.prompt?.map((field) => [field.id, field.secret]),
          [['code', true]],
        )
        assert.ok(started.step.message?.['zh-CN'].includes('授权码'))
        // 不完整的码：CLI 那边接着等，这边再要一次
        const retry = await providers.authContinue({
          attemptId: started.attemptId,
          inputs: { code: 'no-hash' },
        })
        assert.equal(retry.kind, 'prompt')
        const again = await providers.authContinue({
          attemptId: started.attemptId,
          inputs: { code: 'half#' },
        })
        assert.equal(again.kind, 'prompt')
        const done = await providers.authContinue({
          attemptId: started.attemptId,
          inputs: { code: ' good#state ' },
        })
        assert.deepEqual(done, {
          kind: 'done',
          auth: { signedIn: true, kind: 'oauth', label: 'dev@example.test · max' },
        })
        await rejectsWith(
          () =>
            providers.authContinue({
              attemptId: started.attemptId,
              inputs: { code: 'good#state' },
            }),
          'notFound',
        )
        await new Promise((resolve) => setTimeout(resolve, 50))
        const updated = events.find((event) => event.method === 'litch/harness/auth/updated')
        assert.deepEqual(updated?.params, {
          harness: 'claude-code',
          attemptId: started.attemptId,
          providerId: 'anthropic',
          step: done,
        })
        assert.ok(events.some((event) => event.method === 'litch/harness/config/changed'))
        // 登录和查状态用的是账号的环境：不开设备上的浏览器，设备环境里的 API key 不带进去
        const login = (await calls(claude)).find((call) => call.args[1] === 'login')
        assert.deepEqual(login, {
          args: ['auth', 'login', '--claudeai'],
          BROWSER: 'true',
          ANTHROPIC_API_KEY: null,
          ANTHROPIC_BASE_URL: null,
          CLAUDE_CODE_OAUTH_TOKEN: null,
        })
        const read = await providers.read()
        assert.equal(read.providers[0]!.canLogout, true)
        assert.equal(read.providers[0]!.auth.label, 'dev@example.test · max')
        assert.ok(
          read.providers[0]!.auth.detail,
          '没选过 provider 而设备环境里有 ANTHROPIC_API_KEY 时提示',
        )

        // 失败带上 CLI 的原话
        const failing = await providers.authStart({ providerId: 'anthropic', methodId: 'console' })
        const failed = await providers.authContinue({
          attemptId: failing.attemptId,
          inputs: { code: 'bad#code' },
        })
        assert.equal(failed.kind, 'failed')
        if (failed.kind === 'failed') assert.match(failed.message['zh-CN'], /status code 400/)

        // 取消：通知里是失败；再开一次会把上一次顶掉
        const first = await providers.authStart({ providerId: 'anthropic', methodId: 'console' })
        const second = await providers.authStart({ providerId: 'anthropic', methodId: 'console' })
        await rejectsWith(
          () =>
            providers.authContinue({ attemptId: first.attemptId, inputs: { code: 'good#state' } }),
          'notFound',
        )
        providers.authCancel({ attemptId: second.attemptId })
        await new Promise((resolve) => setTimeout(resolve, 50))
        const cancelled = events.filter(
          (event) =>
            event.method === 'litch/harness/auth/updated' &&
            event.params.attemptId === second.attemptId,
        )
        assert.equal(cancelled.length, 1)
        assert.equal(cancelled[0]!.params.step.kind, 'failed')

        await providers.authLogout({ providerId: 'anthropic' })
        assert.equal((await providers.read()).providers[0]!.auth.signedIn, false)
      } finally {
        providers.close()
      }
    },
    { ANTHROPIC_API_KEY: 'sk-ant-api-device-env' },
  ))

test('HC-CLAUDE-009：真实 CLI 的 claude auth login 给出授权链接、认粘贴码（只到粘贴为止）', () =>
  isolated(async ({ root, claude }) => {
    // 只给最少的环境：临时主目录和配置目录，不带任何凭据；不会走到写钥匙串那一步
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: claude,
      CLAUDE_CODE_TMPDIR: join(root, 'ct'),
      CHA_CLAUDE_CLI: requiredClaudeCli(),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    const status = await claudeAuthStatus(env)
    assert.equal(status.loggedIn, false)
    assert.equal(status.authMethod, 'none')
    const attempt = new ClaudeLoginAttempt('claudeai')
    try {
      const url = new URL(await attempt.start(env))
      assert.equal(url.protocol, 'https:')
      assert.match(url.pathname, /oauth\/authorize$/)
      assert.equal(url.searchParams.get('code'), 'true')
      // 手动授权的链接回调到官方页面（页面上给出 code#state），不回调设备的 127.0.0.1
      assert.doesNotMatch(url.searchParams.get('redirect_uri') ?? '', /localhost|127\.0\.0\.1/)
      assert.ok(url.searchParams.get('state'))
      assert.equal(await attempt.submit('not-a-code'), null)
      assert.equal(attempt.outcome, null, '格式不对时 CLI 还在等')
    } finally {
      attempt.cancel()
    }
    assert.deepEqual(attempt.outcome, { kind: 'cancelled' })
  }))

// 经适配器进程（模拟运行时）走一遍：方法路由、错误的 data、通知只发给声明过的连接、默认模型的搬迁与两头一致、MCP 授权
test('HC-CLAUDE-010：经适配器调 litch/harness/*，默认模型以 settings.json 为准', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'harness-config-wire-'))
  await mkdir(join(home, 'adapter'), { recursive: true })
  await writeFile(
    join(home, 'adapter', 'config.json'),
    JSON.stringify({ model: 'haiku', overrides: {} }),
  )
  const fixture = new OAuthMcpFixture(join(home, 'effect.txt'))
  const client = await ProtocolClient.start(
    home,
    'http://127.0.0.1:1',
    true,
    'api-key',
    {},
    declaring('harnessConfig'),
  )
  client.standardView = (method, _kind, payload) =>
    method.startsWith('litch/harness/') ? undefined : payload
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await client.raw(method, { harness: 'claude-code', ...params })
    if (response.error) throw new Error(JSON.stringify(response.error))
    return response.result
  }
  try {
    const settingsPath = join(home, 'claude', 'settings.json')
    assert.equal(
      (await readJson(settingsPath)).model,
      'haiku',
      '启动时把旧的默认模型搬进 settings.json',
    )
    assert.equal((await readJson(join(home, 'adapter', 'config.json'))).model, undefined)
    assert.equal((await client.request('config/read')).config.model, 'haiku')

    const read = await call('litch/harness/config/read')
    assert.equal(read.values.model, 'haiku')
    assert.ok(read.settings.find((item: any) => item.key === 'model').options.length > 0)
    await call('litch/harness/config/write', {
      edits: [
        { key: 'model', value: 'sonnet' },
        { key: 'effortLevel', value: 'low' },
      ],
      expectedVersion: read.version,
    })
    const codex = await client.request('config/read')
    assert.equal(codex.config.model, 'sonnet')
    assert.equal(codex.config.model_reasoning_effort, 'low')
    assert.equal((await client.request('thread/start', { cwd: home })).model, 'sonnet')
    const changed = await client.notification('litch/harness/config/changed')
    assert.deepEqual(changed, { harness: 'claude-code', part: 'config' })

    // 反过来：官方桌面端经 config/batchWrite 改默认模型，也写进 settings.json
    await client.request('config/batchWrite', {
      edits: [
        { keyPath: 'model', value: 'opus', mergeStrategy: 'replace' },
        { keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' },
        { keyPath: 'sandbox_mode', value: 'read-only', mergeStrategy: 'replace' },
      ],
    })
    const settings = await readJson(settingsPath)
    assert.equal(settings.model, 'opus')
    assert.equal(settings.effortLevel, 'high')
    const adapterConfig = await readJson(join(home, 'adapter', 'config.json'))
    assert.equal(adapterConfig.model, undefined)
    assert.equal(adapterConfig.overrides.sandbox_mode, 'read-only')

    const rejected = await client.raw('litch/harness/config/write', {
      harness: 'claude-code',
      edits: [{ key: 'effortLevel', value: 'max' }],
      expectedVersion: (await call('litch/harness/config/read')).version,
    })
    assert.equal(rejected.error.code, -32000)
    assert.equal(rejected.error.data.litch, 'invalidValue')
    assert.equal(rejected.error.data.key, 'effortLevel')
    assert.equal(rejected.error.data.harness, 'claude-code')

    // provider 的选择记在 config.json，但不出现在给官方桌面端的 config/read 里
    const providers = await call('litch/harness/providers/read')
    await call('litch/harness/providers/activate', {
      providerId: 'api-key',
      expectedVersion: providers.version,
    })
    assert.equal(
      (await readJson(join(home, 'adapter', 'config.json'))).overrides.litch_provider.active,
      'api-key',
    )
    assert.equal((await client.request('config/read')).config.litch_provider, undefined)

    // MCP：写进 .claude.json，再走现有的 OAuth 登录
    const mcp = await call('litch/harness/mcp/read')
    await call('litch/harness/mcp/upsert', {
      server: { name: 'secure', transport: 'http', enabled: true, url: await fixture.start() },
      expectedVersion: mcp.version,
    })
    assert.equal(
      (await readJson(join(home, 'claude', '.claude.json'))).mcpServers.secure.type,
      'http',
    )
    const login = await call('litch/harness/mcp/login', { name: 'secure' })
    assert.equal(login.step.kind, 'openUrl')
    const redirect = new URL(new URL(login.step.url).searchParams.get('redirect_uri')!)
    assert.equal(login.step.callbackPort, Number(redirect.port))
    const authorized = await fetch(login.step.url, { redirect: 'manual' })
    assert.equal(authorized.status, 302)
    assert.equal((await fetch(authorized.headers.get('location')!)).status, 200)
    const updated = await client.notification(
      'litch/harness/auth/updated',
      (params) => params.attemptId === login.attemptId,
    )
    assert.deepEqual(updated, {
      harness: 'claude-code',
      attemptId: login.attemptId,
      mcpServer: 'secure',
      step: { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: null } },
    })
    assert.deepEqual(fixture.errors, [])
  } finally {
    await client.close()
    await fixture.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('HC-CLAUDE-011：没声明 harnessConfig 的连接方法照样能调，收不到通知', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'harness-config-undeclared-'))
  const client = await ProtocolClient.start(home, 'http://127.0.0.1:1', true)
  try {
    const read = await client.raw('litch/harness/config/read', { harness: 'claude-code' })
    await client.raw('litch/harness/config/write', {
      harness: 'claude-code',
      edits: [{ key: 'autoMemoryEnabled', value: false }],
      expectedVersion: read.result.version,
    })
    const instructions = await client.raw('litch/harness/instructions/read', {
      harness: 'claude-code',
    })
    assert.equal(instructions.result.path, join(home, 'claude', 'CLAUDE.md'))
    await client.request('config/read')
    assert.equal(
      client.trace.some(
        (message) =>
          message.direction !== 'client' &&
          message.id === undefined &&
          typeof message.method === 'string' &&
          message.method.startsWith('litch/harness/'),
      ),
      false,
    )
    assert.equal((await readJson(join(home, 'claude', 'settings.json'))).autoMemoryEnabled, false)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
