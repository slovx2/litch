import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  providerLaunch,
  withFlagSettings,
  writeProviderConfig,
  writeProviderSecret,
} from '../src/claude-provider.mjs'
import {
  contextFilesScope,
  contextModelKey,
  contextWindowsPath,
  modelWindowCacheKey,
  readContextWindows,
} from '../src/context-windows.mjs'
import { ClaudeHarnessConfig, readClaudeConfig, writeClaudeConfig } from '../src/harness-config.mjs'

const models = [
  { provider: 'anthropic', model: 'claude-opus-4-6[1m]' },
  { provider: 'anthropic', model: 'claude-opus-4-6' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'work', model: 'claude-opus-4-6' },
]
const opus = 'litch_context_windows.anthropic.claude-opus-4-6'
const sonnet = 'litch_context_windows.anthropic.claude-sonnet-4-6'
const work = 'litch_context_windows.work.claude-opus-4-6'

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'context-windows-'))
  const previous = Object.fromEntries(
    ['CLAUDE_CONFIG_DIR', 'CHA_CLAUDE_HOME', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'].map((key) => [
      key,
      process.env[key],
    ]),
  )
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  process.env.CHA_CLAUDE_HOME = join(root, 'adapter')
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  writeProviderConfig({
    last: null,
    removed: [],
    providers: {
      work: {
        kind: 'apiKey',
        title: 'Work',
        baseUrl: null,
        authHeader: 'apiKey',
        models: [],
        smallModel: null,
      },
    },
  })
  writeProviderSecret('work', 'unit-test-key')
  try {
    await run(root)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

test('CTX-001：同型号不同供应商分别持久化、整表注入、保留兄弟设置与凭据隔离', async () =>
  isolated(async () => {
    const before = readClaudeConfig([], models)
    assert.equal(before.settings.filter((row) => row.key === opus).length, 1)
    const write = writeClaudeConfig(
      [
        { key: opus, value: 400000 },
        { key: sonnet, value: 200000 },
        { key: work, value: 300000 },
        { key: 'language', value: 'Chinese' },
      ],
      before.version,
      [],
      models,
    )
    assert.notEqual(write.version, before.version)
    assert.throws(
      () => writeClaudeConfig([{ key: opus, value: 600000 }], before.version, [], models),
      /变了/,
    )
    assert.deepEqual(readContextWindows(), {
      anthropic: { 'claude-opus-4-6': 400000, 'claude-sonnet-4-6': 200000 },
      work: { 'claude-opus-4-6': 300000 },
    })
    const account = providerLaunch('anthropic', 'opus', {})
    const provider = providerLaunch('work', 'opus', {})
    assert.equal(account.managed, false)
    assert.equal(provider.managed, true)
    assert.equal(provider.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined)
    assert.equal(
      provider.flagSettings?.modelSettings?.['claude-opus-4-6']?.autoCompactWindow,
      300000,
    )
    const settings = withFlagSettings(
      { modelSettings: { 'claude-opus-4-6': { effortLevel: 'high' } } },
      account,
    )
    assert.deepEqual(settings.modelSettings, {
      'claude-opus-4-6': { effortLevel: 'high', autoCompactWindow: 400000 },
      'claude-sonnet-4-6': { autoCompactWindow: 200000 },
    })
    assert.ok(!JSON.stringify(provider.flagSettings).includes('unit-test-key'))
    const changed = readClaudeConfig([], models)
    writeClaudeConfig([{ key: work, value: 350000 }], changed.version, [], models)
    const next = providerLaunch('work', 'opus', {})
    assert.notEqual(next.scope, provider.scope)
    assert.equal(next.routingScope, provider.routingScope)
    assert.equal(providerLaunch('anthropic', 'opus', {}).scope, account.scope)
    assert.notEqual(
      modelWindowCacheKey(account.scope, 'same'),
      modelWindowCacheKey(provider.scope, 'same'),
    )
    assert.equal(contextModelKey('claude-opus-4-6-20260101[1m]'), 'claude-opus-4-6')
  }))

test('CTX-002：500K 来源与受覆盖模型可见，显式转默认；并发修改拒绝，保留无关 env', async () =>
  isolated(async (root) => {
    const settingsPath = join(root, 'claude', 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', KEEP: 'yes' },
        modelSettings: { 'claude-opus-4-6': { effortLevel: 'high' } },
      }),
    )
    const beforeScope = contextFilesScope(root)
    const first = readClaudeConfig([], models)
    writeClaudeConfig([{ key: opus, value: 400000 }], first.version, [], models)
    const shown = readClaudeConfig([], models)
    assert.deepEqual(shown.overridden?.[opus], {
      value: 500000,
      by: { 'zh-CN': '用户 settings.json env', en: 'User settings.json env' },
    })
    assert.equal(shown.actions.length, 2)
    const harness = new ClaudeHarnessConfig({
      broadcast() {},
      modelOptions: () => [],
      contextModels: () => models,
      defaultsChanged() {},
      mcpLogin: async () => ({ authorizationUrl: '' }),
    })
    try {
      await assert.rejects(
        harness.dispatch('litch/harness/config/action', {
          actionId: 'context-window.use-default',
          expectedVersion: first.version,
        }),
        /变了/,
      )
      await harness.dispatch('litch/harness/config/action', {
        actionId: 'context-window.use-default',
        expectedVersion: shown.version,
      })
      const saved = JSON.parse(await readFile(settingsPath, 'utf8'))
      assert.deepEqual(saved, {
        env: { KEEP: 'yes' },
        modelSettings: { 'claude-opus-4-6': { effortLevel: 'high' } },
        autoCompactWindow: 500000,
      })
      assert.equal(readClaudeConfig([], models).overridden?.[opus], undefined)
      assert.equal(readContextWindows().anthropic?.['claude-opus-4-6'], 400000)
      assert.notEqual(contextFilesScope(root), beforeScope)
    } finally {
      harness.close()
    }
  }))

test('CTX-003：窗口越界不写任一文件；恢复继承只清目标供应商；进程环境覆盖不可静默清除', async () =>
  isolated(async () => {
    const first = readClaudeConfig([], models)
    assert.throws(
      () =>
        writeClaudeConfig(
          [
            { key: opus, value: 99999 },
            { key: 'language', value: 'bad' },
          ],
          first.version,
          [],
          models,
        ),
      /小于/,
    )
    assert.equal(readClaudeConfig([], models).values.language, undefined)
    writeClaudeConfig(
      [
        { key: opus, value: 400000 },
        { key: work, value: 300000 },
      ],
      first.version,
      [],
      models,
    )
    const second = readClaudeConfig([], models)
    writeClaudeConfig([{ key: opus, value: null }], second.version, [], models)
    assert.equal(readContextWindows().anthropic?.['claude-opus-4-6'], undefined)
    assert.equal(readContextWindows().work?.['claude-opus-4-6'], 300000)
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '600000'
    const shown = readClaudeConfig([], models)
    assert.equal(shown.overridden?.[work]?.value, 600000)
    assert.equal(shown.overridden?.[work]?.by['zh-CN'], '设备启动环境')
    assert.deepEqual(shown.actions, [])
    assert.ok(await readFile(contextWindowsPath(), 'utf8'))
  }))
