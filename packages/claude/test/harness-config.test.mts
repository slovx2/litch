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
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ClaudeLoginAttempt, claudeAuthStatus } from '../src/claude-auth.mjs'
import { migrateDefaultModel, readSettingsDefaults } from '../src/claude-default-model.mjs'
import {
  ACCOUNT_PROVIDER,
  hasProviderPrefix,
  joinModelRef,
  NATIVE_PROVIDER,
  nativeOverrides,
  ProviderUnavailableError,
  parseProviderConfig,
  plainProvider,
  providerLaunch,
  readProviderConfig,
  readProviderSecrets,
  splitModelRef,
  withFlagSettings,
  writeProviderConfig,
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
import { summarizeRpcParams } from '../src/server-helpers.mjs'
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

test('HC-CLAUDE-012：遥测、模型、上下文窗口的项读写 settings.json 的 env，字符串换算对，别的键和顺序不动，密钥不回显', () =>
  isolated(async ({ claude }) => {
    const settingsPath = join(claude, 'settings.json')
    // 照常见的本机配置造的：模型带 [1m]、按模型的强度、env 里关掉遥测和自动更新、调大压缩窗口
    const original = {
      model: 'opus[1m]',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
      env: {
        DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
        SOME_OTHER_VAR: 'keep me',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer secret-token',
      },
      someFutureKey: { nested: true },
    }
    await writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`)

    const first = readClaudeConfig([])
    const groups = first.groups.map((group) => group.id)
    for (const id of ['models', 'context', 'telemetry', 'otel']) assert.ok(groups.includes(id), id)
    const byKey = new Map(first.settings.map((item) => [item.key, item]))
    for (const key of [
      'availableModels',
      'modelSettings',
      'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
      'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
      'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'env.ANTHROPIC_DEFAULT_FABLE_MODEL',
      'env.CLAUDE_CODE_SUBAGENT_MODEL',
      'env.CLAUDE_CODE_DISABLE_1M_CONTEXT',
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'autoCompactWindow',
      'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
      'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'env.DISABLE_TELEMETRY',
      'env.DO_NOT_TRACK',
      'env.DISABLE_ERROR_REPORTING',
      'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
      'env.DISABLE_FEEDBACK_COMMAND',
      'env.DISABLE_AUTOUPDATER',
      'env.CLAUDE_CODE_ENABLE_TELEMETRY',
      'env.OTEL_METRICS_EXPORTER',
      'env.OTEL_LOGS_EXPORTER',
      'env.OTEL_EXPORTER_OTLP_PROTOCOL',
      'env.OTEL_EXPORTER_OTLP_ENDPOINT',
      'env.OTEL_EXPORTER_OTLP_HEADERS',
      'otelHeadersHelper',
      'env.OTEL_METRIC_EXPORT_INTERVAL',
      'env.OTEL_LOGS_EXPORT_INTERVAL',
      'env.OTEL_LOG_USER_PROMPTS',
      'env.OTEL_LOG_TOOL_DETAILS',
    ]) {
      const item = byKey.get(key)
      assert.ok(item, key)
      assert.ok(groups.includes(item.group), `${key} 的分组 ${item.group}`)
      assert.equal(item.effect, 'newSession', key)
    }
    assert.equal(byKey.get('env.DISABLE_TELEMETRY')?.type, 'boolean')
    assert.equal(byKey.get('env.CLAUDE_CODE_AUTO_COMPACT_WINDOW')?.type, 'integer')
    assert.equal(byKey.get('env.OTEL_EXPORTER_OTLP_HEADERS')?.type, 'secret')

    // 读：开关是布尔，窗口是整数，密钥只说有没有
    assert.equal(first.values.model, 'opus[1m]')
    assert.deepEqual(first.values.modelSettings, { 'claude-opus-5-5': { effortLevel: 'high' } })
    assert.equal(first.values['env.DISABLE_TELEMETRY'], true)
    assert.equal(first.values['env.DO_NOT_TRACK'], true)
    assert.equal(first.values['env.DISABLE_ERROR_REPORTING'], true)
    assert.equal(first.values['env.DISABLE_AUTOUPDATER'], true)
    assert.equal(first.values['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW'], 500000)
    assert.equal(first.values['env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], undefined)
    assert.equal(first.values['env.CLAUDE_CODE_DISABLE_1M_CONTEXT'], undefined)
    assert.deepEqual(first.values['env.OTEL_EXPORTER_OTLP_HEADERS'], { set: true })
    assert.ok(!JSON.stringify(first).includes('secret-token'))

    // 改：在原位改值，删掉的键不留空串，新加的接在后面；没碰的键原样
    const written = writeClaudeConfig(
      [
        { key: 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: 400000 },
        { key: 'env.DO_NOT_TRACK', value: false },
        { key: 'env.CLAUDE_CODE_DISABLE_1M_CONTEXT', value: true },
        { key: 'env.OTEL_EXPORTER_OTLP_HEADERS', value: '' },
        { key: 'env.OTEL_METRICS_EXPORTER', value: 'otlp,console' },
        { key: 'availableModels', value: ['opus', 'sonnet'] },
        { key: 'modelSettings', value: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } },
      ],
      first.version,
      [],
    )
    assert.equal(written.restartRequired, false)
    const saved = await readJson(settingsPath)
    assert.deepEqual(Object.keys(saved), [
      'model',
      'modelSettings',
      'env',
      'someFutureKey',
      'availableModels',
    ])
    assert.deepEqual(saved.env, {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      SOME_OTHER_VAR: 'keep me',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer secret-token',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      OTEL_METRICS_EXPORTER: 'otlp,console',
    })
    assert.equal(saved.model, 'opus[1m]')
    assert.deepEqual(saved.modelSettings, { 'claude-opus-5-5': { effortLevel: 'xhigh' } })
    assert.deepEqual(saved.someFutureKey, { nested: true })
    assert.deepEqual(saved.availableModels, ['opus', 'sonnet'])

    // 换密钥、关掉开关就删键；“0” 对只看有没有值的变量仍算开
    const second = readClaudeConfig([])
    assert.equal(second.version, written.version)
    const cleared = writeClaudeConfig(
      [
        { key: 'env.OTEL_EXPORTER_OTLP_HEADERS', value: 'x-api-key=new' },
        { key: 'env.DISABLE_TELEMETRY', value: false },
        { key: 'env.DISABLE_ERROR_REPORTING', value: null },
        { key: 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: null },
        { key: 'env.OTEL_METRICS_EXPORTER', value: null },
      ],
      second.version,
      [],
    )
    const after = await readJson(settingsPath)
    assert.deepEqual(after.env, {
      DISABLE_AUTOUPDATER: '1',
      SOME_OTHER_VAR: 'keep me',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=new',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    })
    assert.equal(readClaudeConfig([]).version, cleared.version)

    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { DISABLE_TELEMETRY: '0', DO_NOT_TRACK: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64k' },
      }),
    )
    const odd = readClaudeConfig([])
    assert.equal(odd.values['env.DISABLE_TELEMETRY'], true)
    assert.equal(odd.values['env.DO_NOT_TRACK'], false)
    assert.equal(odd.values['env.CLAUDE_CODE_MAX_OUTPUT_TOKENS'], undefined)

    // 范围和类型不对的整个拒绝
    await rejectsWith(
      () =>
        writeClaudeConfig(
          [{ key: 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: 50000 }],
          odd.version,
          [],
        ),
      'invalidValue',
    )
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'env.DISABLE_TELEMETRY', value: '1' }], odd.version, []),
      'invalidValue',
    )
    await rejectsWith(
      () => writeClaudeConfig([{ key: 'otelHeadersHelper', value: '  ' }], odd.version, []),
      'invalidValue',
    )
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
    // 照软链里写的报，不做 realpath（macOS 的临时目录在 /var 下，realpath 会变成 /private/var）
    assert.equal(linked.linkTarget, source)
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

test('HC-CLAUDE-006：按会话的供应商算起 CLI 的环境，没填密钥绝不退回账号', () => {
  const base = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'from-device-env',
    ANTHROPIC_BASE_URL: 'https://old.example.test',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: 'opus',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Old: 1',
  }
  // 以前的版本存密钥的变量：哪家都不带下去
  const legacy = { ...base, LITCH_CLAUDE_API_KEY: 'sk-ant-api-old' }
  const config = {
    last: null,
    providers: {
      corp: {
        kind: 'gateway' as const,
        title: '公司网关',
        baseUrl: 'https://gw.example.test',
        authHeader: 'bearer' as const,
        models: [{ id: 'glm-4.6', title: null }],
        smallModel: 'glm-4.5-air',
        headers: 'X-Team: a',
      },
      work: {
        kind: 'apiKey' as const,
        title: null,
        baseUrl: null,
        authHeader: 'apiKey' as const,
        models: [],
        smallModel: null,
        headers: null,
      },
    },
  }
  const secrets = { corp: 'gw-token', work: 'sk-ant-api-work' }

  // native：用户自己的配置，原样
  const native = providerLaunch(NATIVE_PROVIDER, null, legacy, config, secrets)
  assert.deepEqual(native.env, base)
  assert.equal(native.flagSettings, null)

  // 账号：凭据、地址、云厂商开关去掉，设置文件里的同名项在命令行设置层置空
  const account = providerLaunch(ACCOUNT_PROVIDER, null, legacy, config, secrets)
  assert.deepEqual(account.env, {
    PATH: '/bin',
    ANTHROPIC_MODEL: 'opus',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Old: 1',
  })
  assert.equal(account.managed, false)
  assert.equal(account.flagSettings?.apiKeyHelper, '')
  assert.equal(account.flagSettings?.env?.ANTHROPIC_API_KEY, '')
  assert.equal(account.flagSettings?.env?.ANTHROPIC_BASE_URL, '')
  assert.equal(account.flagSettings?.env?.CLAUDE_CODE_USE_BEDROCK, '')
  assert.equal(account.flagSettings?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  // 外面带进来的长期令牌是账号凭据，留着；存了令牌时换成存的
  assert.equal(
    providerLaunch(ACCOUNT_PROVIDER, null, { CLAUDE_CODE_OAUTH_TOKEN: 'outer' }, config, secrets)
      .env.CLAUDE_CODE_OAUTH_TOKEN,
    'outer',
  )
  const withToken = providerLaunch(ACCOUNT_PROVIDER, null, base, config, {
    ...secrets,
    anthropic: 'sk-ant-oat-stored',
  })
  assert.equal(withToken.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-stored')
  assert.notEqual(withToken.scope, account.scope)

  // API key：托管模式，x-api-key，官方地址
  const work = providerLaunch('work', 'opus', legacy, config, secrets)
  assert.deepEqual(work.env, {
    PATH: '/bin',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    ANTHROPIC_API_KEY: 'sk-ant-api-work',
  })
  assert.equal(work.managed, true)
  assert.equal(work.flagSettings, null)

  // 网关：Bearer、地址、两档都指向所选型号，小模型另配，额外请求头换成它的
  const corp = providerLaunch('corp', 'glm-4.6', base, config, secrets)
  assert.deepEqual(corp.env, {
    PATH: '/bin',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    ANTHROPIC_BASE_URL: 'https://gw.example.test',
    ANTHROPIC_AUTH_TOKEN: 'gw-token',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Team: a',
  })
  // 同一网关换型号不换进程；换密钥、改定义要换
  assert.equal(providerLaunch('corp', 'kimi-k2', base, config, secrets).scope, corp.scope)
  assert.notEqual(
    providerLaunch('corp', 'glm-4.6', base, config, { ...secrets, corp: 'other' }).scope,
    corp.scope,
  )
  const apiKeyHeader = {
    ...config,
    providers: {
      ...config.providers,
      corp: { ...config.providers.corp, authHeader: 'apiKey' as const },
    },
  }
  const corpApiKey = providerLaunch('corp', 'glm-4.6', base, apiKeyHeader, secrets)
  assert.equal(corpApiKey.env.ANTHROPIC_API_KEY, 'gw-token')
  assert.equal(corpApiKey.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.notEqual(corpApiKey.scope, corp.scope)

  // 没填密钥、供应商不在了：报错，不退回账号
  assert.throws(
    () => providerLaunch('corp', 'glm-4.6', base, config, {}),
    (error) => error instanceof ProviderUnavailableError && error.provider === 'corp',
  )
  assert.throws(() => providerLaunch('gone', null, base, config, secrets), ProviderUnavailableError)

  // 命令行设置层：并进已有的 settings，launch 的同名项优先
  assert.deepEqual(
    withFlagSettings({ disableAllHooks: true, env: { A: '1', ANTHROPIC_API_KEY: 'x' } }, account)
      .env,
    { A: '1', ...account.flagSettings?.env },
  )
  assert.deepEqual(withFlagSettings({ disableAllHooks: true }, corp), { disableAllHooks: true })
})

test('HC-CLAUDE-014：型号 ID 的供应商前缀，不带前缀的按用户自己的配置算', () =>
  isolated(async ({ claude }) => {
    const config = parseProviderConfig({
      last: 'corp/glm-4.6',
      providers: {
        corp: { kind: 'gateway', baseUrl: 'https://gw.example.test', models: [{ id: 'glm-4.6' }] },
        work: { kind: 'apiKey' },
        // 认不出的、保留名、网关没地址的都不要
        'bad id': { kind: 'apiKey' },
        anthropic: { kind: 'apiKey' },
        nourl: { kind: 'gateway' },
      },
    })
    assert.deepEqual(Object.keys(config.providers), ['corp', 'work'])
    assert.equal(config.providers.work!.authHeader, 'apiKey')
    assert.equal(config.providers.corp!.authHeader, 'bearer')
    assert.deepEqual(splitModelRef('corp/glm-4.6', config), { provider: 'corp', model: 'glm-4.6' })
    assert.deepEqual(splitModelRef('anthropic/opus[1m]', config), {
      provider: 'anthropic',
      model: 'opus[1m]',
    })
    // 前缀不是已知的供应商：整串是型号（网关自己的型号可能带 /）
    assert.deepEqual(splitModelRef('vendor/model', config), {
      provider: 'anthropic',
      model: 'vendor/model',
    })
    assert.deepEqual(splitModelRef('opus', config), { provider: 'anthropic', model: 'opus' })
    assert.equal(hasProviderPrefix('native/opus', config), true)
    assert.equal(hasProviderPrefix('vendor/model', config), false)
    assert.equal(joinModelRef('corp', 'a/b'), 'corp/a/b')

    assert.deepEqual(nativeOverrides(), [])
    assert.equal(plainProvider(), ACCOUNT_PROVIDER)
    await writeFile(
      join(claude, 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://mine.example.test' },
        apiKeyHelper: 'x',
      }),
    )
    assert.deepEqual(nativeOverrides(), ['ANTHROPIC_BASE_URL', 'apiKeyHelper'])
    assert.equal(plainProvider(), NATIVE_PROVIDER)
    assert.equal(splitModelRef('opus', config).provider, NATIVE_PROVIDER)
    assert.deepEqual(nativeOverrides({ ...process.env, CLAUDE_CODE_USE_VERTEX: '1' }), [
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_VERTEX',
      'apiKeyHelper',
    ])
  }))

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

test('HC-CLAUDE-007：加改删供应商，密钥只进 0600 的密钥文件，没有“当前供应商”', () =>
  isolated(async ({ root, claude, adapter }) => {
    process.env.CHA_CLAUDE_CLI = await withFakeCli(root)
    const events: Array<{ method: string; params: any }> = []
    let changes = 0
    const providers = new ClaudeProviders({
      broadcast: (method, params) => events.push({ method, params }),
      providersChanged: () => changes++,
    })
    let read = await providers.read()
    assert.equal(read.switchable, false)
    assert.deepEqual(
      read.providers.map((provider) => provider.id),
      ['anthropic'],
    )
    const account = read.providers[0]!
    assert.deepEqual(account.auth, { signedIn: false, kind: 'none', label: null })
    assert.deepEqual(
      account.methods.map((method) => [method.id, method.kind]),
      [
        ['claudeai', 'oauthPaste'],
        ['console', 'oauthPaste'],
        ['oauthToken', 'apiKey'],
      ],
    )
    assert.deepEqual(
      read.templates.map((template) => template.id),
      ['anthropicApiKey', 'anthropicGateway'],
    )

    let version = providers.upsert({
      providerId: 'corp',
      templateId: 'anthropicGateway',
      definition: {
        title: '公司网关',
        baseUrl: 'https://gw.example.test',
        apiKey: 'gw-secret-123456789',
        models: ['glm-4.6 = GLM 4.6', 'kimi-k2', 'kimi-k2', ' '],
        smallModel: 'glm-4.5-air',
      },
      expectedVersion: read.version,
    }).version
    assert.equal(changes, 1)
    const secretsPath = join(adapter, 'provider-secrets.json')
    assert.equal((await stat(secretsPath)).mode & 0o777, 0o600)
    assert.deepEqual(await readJson(secretsPath), { secrets: { corp: 'gw-secret-123456789' } })
    const config = await readFile(join(adapter, 'config.json'), 'utf8')
    assert.doesNotMatch(config, /gw-secret/, '密钥不进 config.json')
    assert.deepEqual(JSON.parse(config).overrides.litch_providers.providers.corp.models, [
      { id: 'glm-4.6', title: 'GLM 4.6' },
      { id: 'kimi-k2' },
    ])

    await rejectsWith(
      () =>
        providers.upsert({
          providerId: 'corp',
          templateId: 'anthropicGateway',
          definition: { baseUrl: 'https://x.test' },
          expectedVersion: read.version,
        }),
      'versionConflict',
    )
    for (const providerId of ['anthropic', 'native'])
      await rejectsWith(
        () =>
          providers.upsert({
            providerId,
            templateId: 'anthropicApiKey',
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
    await rejectsWith(
      () =>
        providers.upsert({
          providerId: 'corp',
          templateId: 'anthropicApiKey',
          definition: {},
          expectedVersion: version,
        }),
      'invalidValue',
    )
    await rejectsWith(
      () => providers.activate({ providerId: 'corp', expectedVersion: version }),
      'invalidValue',
    )

    // API key 供应商先不填 key；之后经登录方法填
    version = providers.upsert({
      providerId: 'work',
      templateId: 'anthropicApiKey',
      definition: { title: '工作' },
      expectedVersion: version,
    }).version
    read = await providers.read()
    const corp = read.providers.find((provider) => provider.id === 'corp')!
    assert.equal(corp.kind, 'custom')
    assert.equal(corp.templateId, 'anthropicGateway')
    assert.deepEqual(corp.definition, {
      title: '公司网关',
      baseUrl: 'https://gw.example.test',
      apiKey: { set: true },
      authHeader: 'bearer',
      models: ['glm-4.6 = GLM 4.6', 'kimi-k2'],
      smallModel: 'glm-4.5-air',
    })
    assert.deepEqual(corp.auth, {
      signedIn: true,
      kind: 'apiKey',
      label: '…6789 · gw.example.test',
    })
    const work = read.providers.find((provider) => provider.id === 'work')!
    assert.equal(work.templateId, 'anthropicApiKey')
    assert.deepEqual(work.auth, { signedIn: false, kind: 'none', label: null })
    const prompt = await providers.authStart({ providerId: 'work', methodId: 'apiKey' })
    assert.equal(prompt.step.kind, 'prompt')
    const done = await providers.authStart({
      providerId: 'work',
      methodId: 'apiKey',
      inputs: { apiKey: ' sk-ant-api-work-0000 ' },
    })
    assert.deepEqual(done.step, {
      kind: 'done',
      auth: { signedIn: true, kind: 'apiKey', label: '…0000' },
    })
    assert.equal(readProviderSecrets().work, 'sk-ant-api-work-0000')
    // 原样交回读到的 {set}：密钥不动；空串：清掉
    version = (await providers.read()).version
    version = providers.upsert({
      providerId: 'work',
      templateId: 'anthropicApiKey',
      definition: { title: '工作', apiKey: { set: true } },
      expectedVersion: version,
    }).version
    assert.equal(readProviderSecrets().work, 'sk-ant-api-work-0000')
    await providers.authLogout({ providerId: 'work' })
    assert.equal(readProviderSecrets().work, undefined)

    // 删掉上一次所选型号的供应商：新会话回到账号
    writeProviderConfig({ ...readProviderConfig(), last: 'corp/glm-4.6' })
    version = (await providers.read()).version
    providers.remove({ providerId: 'corp', expectedVersion: version })
    assert.equal(readProviderConfig().last, null)
    assert.deepEqual(readProviderSecrets(), {})
    await rejectsWith(() => providers.remove({ providerId: 'corp' }), 'notFound')

    // 用户自己在 settings.json 里配了网关：多出一个只读的 native
    await writeFile(
      join(claude, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example.test' } }),
    )
    read = await providers.read()
    const native = read.providers.find((provider) => provider.id === 'native')!
    assert.equal(native.kind, 'builtin')
    assert.equal(native.auth.label, 'ANTHROPIC_BASE_URL')
    assert.equal(native.canLogout, false)
    await rejectsWith(() => providers.authLogout({ providerId: 'native' }), 'readOnly')

    assert.ok(events.every((event) => event.method === 'litch/harness/config/changed'))
    assert.ok(
      events.every(
        (event) => event.params.harness === 'claude-code' && event.params.part === 'providers',
      ),
    )
    // 查账号状态用的是账号的环境：settings.json 里的网关地址不在进程环境里
    assert.ok((await calls(claude)).every((call) => call.args[1] === 'status'))
  }))

test('HC-CLAUDE-015：从网关拉型号（回环上的假网关）', () =>
  isolated(async () => {
    const seen: Array<{ url: string; headers: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      if (req.headers.authorization !== 'Bearer gw-token') {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'glm-4.6', display_name: 'GLM 4.6' },
            { id: 'kimi-k2', display_name: 'kimi-k2' },
            { id: 'glm-4.6' },
            { name: 'no-id' },
          ],
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const providers = new ClaudeProviders({ broadcast: () => {} })
    try {
      let version = (await providers.read()).version
      version = providers.upsert({
        providerId: 'corp',
        templateId: 'anthropicGateway',
        definition: { baseUrl: `http://127.0.0.1:${port}/`, apiKey: 'gw-token' },
        expectedVersion: version,
      }).version
      assert.deepEqual(await providers.discoverModels({ providerId: 'corp' }), {
        models: [
          { id: 'glm-4.6', title: 'GLM 4.6' },
          { id: 'kimi-k2', title: null },
        ],
      })
      assert.equal(seen[0]!.url, '/v1/models?limit=1000')
      assert.equal(seen[0]!.headers['x-api-key'], undefined)
      assert.equal(readProviderConfig().providers.corp!.models.length, 0, '只列出来，不写')

      // 密钥不对：报网关回的状态码
      providers.upsert({
        providerId: 'corp',
        templateId: 'anthropicGateway',
        definition: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'wrong' },
        expectedVersion: version,
      })
      const failed = await rejectsWith(
        () => providers.discoverModels({ providerId: 'corp' }),
        'invalidValue',
      )
      assert.match(failed.message, /401/)
      version = (await providers.read()).version
      providers.upsert({
        providerId: 'work',
        templateId: 'anthropicApiKey',
        definition: { apiKey: 'sk-ant-api-x' },
        expectedVersion: version,
      })
      await rejectsWith(() => providers.discoverModels({ providerId: 'work' }), 'invalidValue')
      await rejectsWith(() => providers.discoverModels({ providerId: 'anthropic' }), 'readOnly')
    } finally {
      providers.close()
      await new Promise((resolve) => server.close(resolve))
    }
  }))

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
          () => providers.authStart({ providerId: 'anthropic', methodId: 'nope' }),
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
        // 设备环境里有 ANTHROPIC_API_KEY：它是用户自己的配置，另列一个只读的 native
        assert.deepEqual(
          read.providers.map((provider) => provider.id),
          ['anthropic', 'native'],
        )
        assert.equal(read.providers[1]!.auth.label, 'ANTHROPIC_API_KEY')

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

        // 长期令牌：存进密钥文件，查状态时作为 CLAUDE_CODE_OAUTH_TOKEN 交给 CLI；登出一并清掉
        const token = await providers.authStart({
          providerId: 'anthropic',
          methodId: 'oauthToken',
          inputs: { token: 'sk-ant-oat01-long-lived' },
        })
        assert.deepEqual(token.step, {
          kind: 'done',
          auth: { signedIn: true, kind: 'env', label: 'CLAUDE_CODE_OAUTH_TOKEN' },
        })
        const status = (await calls(claude)).at(-1)
        assert.equal(status.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-long-lived')
        assert.equal(status.ANTHROPIC_API_KEY, null)
        assert.equal((await providers.read()).providers[0]!.canLogout, true)
        await providers.authLogout({ providerId: 'anthropic' })
        assert.equal(readProviderSecrets().anthropic, undefined)
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

    // 供应商的定义记在 config.json，但不出现在给官方桌面端的 config/read 里；加上就进模型选单
    const providers = await call('litch/harness/providers/read')
    await call('litch/harness/providers/upsert', {
      providerId: 'corp',
      templateId: 'anthropicGateway',
      definition: {
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'gw-token',
        models: ['glm-4.6 = GLM 4.6'],
      },
      expectedVersion: providers.version,
    })
    assert.deepEqual(
      Object.keys(
        (await readJson(join(home, 'adapter', 'config.json'))).overrides.litch_providers.providers,
      ),
      ['corp'],
    )
    assert.equal((await client.request('config/read')).config.litch_providers, undefined)
    const models = (await client.request('model/list', {})).data
    const corp = models.find((entry: any) => entry.id === 'corp/glm-4.6')
    assert.equal(corp?.displayName, '[corp] GLM 4.6', JSON.stringify(models))
    const activate = await client.raw('litch/harness/providers/activate', {
      harness: 'claude-code',
      providerId: 'corp',
      expectedVersion: providers.version,
    })
    assert.equal(activate.error.data.litch, 'invalidValue')

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

test('HC-CLAUDE-012：登录时粘贴的授权码不进调试日志（假 CLI）', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'harness-config-log-'))
  const debugLog = join(home, 'debug.jsonl')
  const client = await ProtocolClient.start(home, 'http://127.0.0.1:1', true, 'api-key', {
    CHA_CLAUDE_CLI: await withFakeCli(home),
    CHA_CLAUDE_DEBUG_LOG: debugLog,
  })
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await client.raw(method, { harness: 'claude-code', ...params })
    if (response.error) throw new Error(JSON.stringify(response.error))
    return response.result
  }
  try {
    const started = await call('litch/harness/auth/start', {
      providerId: 'anthropic',
      methodId: 'claudeai',
    })
    assert.equal(started.step.kind, 'openUrl')
    // 不完整的码（假 CLI 接着等）和最后认下的码都不能进日志
    const retry = await call('litch/harness/auth/continue', {
      attemptId: started.attemptId,
      inputs: { code: 'leakcheck-7f3a9c' },
    })
    assert.equal(retry.kind, 'prompt')
    const done = await call('litch/harness/auth/continue', {
      attemptId: started.attemptId,
      inputs: { code: 'good#state' },
    })
    assert.equal(done.kind, 'done')
    // 日志攒到这一轮事件循环末尾才写：等到 auth/continue 的应答那一行出现
    let log = ''
    for (let waited = 0; waited < 5000; waited += 50) {
      log = await readFile(debugLog, 'utf8').catch(() => '')
      if (log.split('\n').filter((line) => line.includes('auth/continue')).length >= 4) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const requests = log
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'rpc.request' && entry.method?.endsWith('/auth/continue'))
    assert.equal(requests.length, 2, '两次 auth/continue 都记了')
    assert.deepEqual(requests[0].params, {
      harness: 'claude-code',
      attemptId: started.attemptId,
      paramKeys: ['harness', 'attemptId', 'inputs'],
    })
    assert.equal(log.includes('leakcheck-7f3a9c'), false)
    assert.equal(log.includes('good#state'), false)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('HC-CLAUDE-013：带密钥的写入方法在调试日志里只记标识和键名', () => {
  const upsert = summarizeRpcParams('litch/harness/mcp/upsert', {
    harness: 'claude-code',
    server: { name: 'gh', transport: 'stdio', env: { GH_PAT: 'ghp_leak' } },
    expectedVersion: 'v1',
  })
  assert.deepEqual(upsert, {
    harness: 'claude-code',
    paramKeys: ['harness', 'server', 'expectedVersion'],
  })
  const batch = summarizeRpcParams('config/batchWrite', {
    edits: [{ keyPath: 'env', value: { MY_PAT: 'leak' } }],
  })
  assert.equal(JSON.stringify(batch).includes('leak'), false)
  // 别的方法照旧
  assert.deepEqual(summarizeRpcParams('thread/read', { threadId: 't1' }), { threadId: 't1' })
})
