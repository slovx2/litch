import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  readProviderConfig,
  writeProviderConfig,
  writeProviderSecret,
} from '../src/claude-provider.mjs'
import {
  allSelectableModelOptions,
  catalogModelId,
  defaultSelectableModelId,
  extraModelOption,
  invalidateProviderCatalogs,
  isSelectableModel,
  loadRuntimeModelCatalog,
  runModel,
  usableProviders,
} from '../src/server-helpers.mjs'
import type { ClaudeRuntime, NativeModelInfo } from '../src/types.mjs'

// 模型目录按供应商拼：账号、native、API key 供应商各自的原生目录（这里是假的运行时），网关的手填型号。
// 每个用例自己的 Claude 配置目录和适配器目录；查账号登录状态用假 CLI（状态记在配置目录里）。

const fakeCli = fileURLToPath(
  new URL('../../../test/fixtures/fake-claude-auth.mjs', import.meta.url),
)

const catalogs: Record<string, NativeModelInfo[]> = {
  anthropic: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: '' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5' },
  ],
  native: [{ value: 'default', displayName: 'Default', description: '' }],
  work: [
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: '' },
  ],
}

function fakeRuntime(
  asked: Array<string | null | undefined>,
  from: Record<string, NativeModelInfo[]> = catalogs,
): ClaudeRuntime {
  return {
    supportedModels: async (provider?: string | null) => {
      asked.push(provider)
      return from[provider ?? 'anthropic'] ?? []
    },
  } as unknown as ClaudeRuntime
}

async function withProviders(
  run: (paths: { claude: string }) => Promise<void>,
  signedIn = true,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'claude-providers-'))
  const claude = join(root, 'claude')
  await mkdir(claude, { recursive: true })
  const cli = join(root, 'fake-claude.mjs')
  await copyFile(fakeCli, cli)
  await chmod(cli, 0o755)
  if (signedIn)
    await writeFile(
      join(claude, 'fake-auth.json'),
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.test' }),
    )
  const names = [
    'CLAUDE_CONFIG_DIR',
    'CHA_CLAUDE_HOME',
    'CHA_CLAUDE_CLI',
    'CHA_CLAUDE_MODELS',
    'CHA_CLAUDE_DEFAULT_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: claude,
    CHA_CLAUDE_HOME: join(root, 'adapter'),
    CHA_CLAUDE_CLI: cli,
  })
  invalidateProviderCatalogs()
  try {
    await run({ claude })
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    invalidateProviderCatalogs()
    await rm(root, { recursive: true, force: true })
  }
}

function addProviders(): void {
  writeProviderConfig({
    last: null,
    providers: {
      corp: {
        kind: 'gateway',
        title: 'Corp',
        baseUrl: 'https://gw.example.test',
        authHeader: 'bearer',
        models: [
          { id: 'glm-4.6', title: 'GLM 4.6', contextWindow: null },
          { id: 'vendor/kimi', title: null, contextWindow: null },
        ],
        smallModel: null,
      },
      work: {
        kind: 'apiKey',
        title: null,
        baseUrl: null,
        authHeader: 'apiKey',
        models: [],
        smallModel: null,
      },
    },
    removed: [],
  })
}

const rows = () =>
  allSelectableModelOptions().map((option) => [option.id, option.displayName, option.isDefault])

test('PROVIDERS-001：只有账号时型号 ID 不带前缀、显示名不加供应商', () =>
  withProviders(async () => {
    const asked: Array<string | null | undefined> = []
    await loadRuntimeModelCatalog(fakeRuntime(asked))
    assert.deepEqual(asked, ['anthropic'])
    assert.deepEqual(rows(), [
      ['default', 'Default · Opus 5.5', true],
      ['sonnet', 'Sonnet', false],
    ])
    assert.deepEqual(runModel('sonnet'), { provider: 'anthropic', model: 'sonnet' })
    assert.deepEqual(runModel('default'), { provider: 'anthropic', model: null })
    assert.equal(catalogModelId('SONNET'), 'sonnet')
  }))

test('PROVIDERS-002：多家能用时型号带前缀、显示“[供应商] 型号”，没填密钥的不进选单', () =>
  withProviders(async () => {
    addProviders()
    writeProviderSecret('corp', 'gw-token')
    const asked: Array<string | null | undefined> = []
    await loadRuntimeModelCatalog(fakeRuntime(asked))
    // work 没填密钥：不列；网关不问 CLI
    assert.deepEqual(usableProviders(), ['anthropic', 'corp'])
    assert.deepEqual(asked, ['anthropic'])
    assert.deepEqual(rows(), [
      ['anthropic/default', '[Account] Default · Opus 5.5', true],
      ['anthropic/sonnet', '[Account] Sonnet', false],
      ['corp/glm-4.6', '[Corp] GLM 4.6', false],
      ['corp/vendor/kimi', '[Corp] vendor/kimi', false],
    ])
    assert.equal(defaultSelectableModelId(), 'anthropic/default')
    // 以前的会话记的是不带前缀的型号：落到账号那一行
    assert.equal(catalogModelId('sonnet'), 'anthropic/sonnet')
    assert.equal(catalogModelId('corp/GLM-4.6'), 'corp/glm-4.6')
    assert.deepEqual(runModel('corp/vendor/kimi'), { provider: 'corp', model: 'vendor/kimi' })
    assert.deepEqual(runModel('anthropic/default'), { provider: 'anthropic', model: null })
    assert.deepEqual(runModel('anthropic/opus[1m]'), { provider: 'anthropic', model: 'opus[1m]' })
    // 网关的型号不限于清单；账号的仍只认 CLI 的别名和完整型号
    assert.equal(isSelectableModel('corp/anything'), true)
    assert.equal(isSelectableModel('anthropic/gpt-5'), false)
    assert.equal(isSelectableModel('opus'), true)
    assert.equal(extraModelOption('corp/other', false).displayName, '[Corp] other')

    // 填上 work 的密钥：它的目录按它自己的 key 问 CLI
    writeProviderSecret('work', 'sk-ant-api-work')
    invalidateProviderCatalogs()
    await loadRuntimeModelCatalog(fakeRuntime(asked))
    assert.deepEqual(asked.slice(1).sort(), ['anthropic', 'work'])
    assert.deepEqual(
      allSelectableModelOptions()
        .filter((option) => option.id.startsWith('work/'))
        .map((option) => [option.id, option.displayName, option.isDefault]),
      [['work/haiku', '[work] Haiku 4.5', false]],
    )
  }))

test('PROVIDERS-003：账号没登录、又有别家能用时账号不进选单', () =>
  withProviders(async () => {
    addProviders()
    writeProviderSecret('corp', 'gw-token')
    await loadRuntimeModelCatalog(fakeRuntime([]))
    assert.deepEqual(usableProviders(), ['corp'])
    // 只剩一家、又不是不带前缀的型号所属的那家：ID 照样带前缀，显示名不加
    assert.deepEqual(rows(), [
      ['corp/glm-4.6', 'GLM 4.6', true],
      ['corp/vendor/kimi', 'vendor/kimi', false],
    ])
    assert.equal(defaultSelectableModelId(), 'corp/glm-4.6')
  }, false))

test('PROVIDERS-004：用户自己在 settings.json 里配了网关，不带前缀的型号归它', () =>
  withProviders(async ({ claude }) => {
    await writeFile(
      join(claude, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example.test' } }),
    )
    const asked: Array<string | null | undefined> = []
    await loadRuntimeModelCatalog(fakeRuntime(asked))
    assert.deepEqual(usableProviders(), ['anthropic', 'native'])
    assert.deepEqual(asked.sort(), ['anthropic', 'native'])
    assert.deepEqual(rows(), [
      ['anthropic/default', '[Account] Default · Opus 5.5', true],
      ['anthropic/sonnet', '[Account] Sonnet', false],
      ['native/default', '[Claude Code] Default', false],
    ])
    assert.deepEqual(runModel('opus'), { provider: 'native', model: 'opus' })
    assert.equal(catalogModelId('default'), 'native/default')
  }))

test('PROVIDERS-005：删掉的供应商的型号仍认得出是它，供应商前缀区分大小写', () =>
  withProviders(async () => {
    addProviders()
    writeProviderSecret('corp', 'gw-token')
    await loadRuntimeModelCatalog(fakeRuntime([]))
    // 型号只差大小写的照目录里的写法；前缀只差大小写的不是这一家
    assert.equal(catalogModelId('corp/GLM-4.6'), 'corp/glm-4.6')
    assert.equal(catalogModelId('Corp/glm-4.6'), 'Corp/glm-4.6')
    assert.equal(isSelectableModel('Corp/glm-4.6'), false)
    assert.deepEqual(runModel('Corp/glm-4.6'), { provider: 'anthropic', model: 'Corp/glm-4.6' })

    const { corp: _, ...rest } = readProviderConfig().providers
    writeProviderConfig({ ...readProviderConfig(), providers: rest, removed: ['corp'] })
    invalidateProviderCatalogs()
    await loadRuntimeModelCatalog(fakeRuntime([]))
    assert.deepEqual(usableProviders(), ['anthropic'])
    // 不落到账号：起 CLI 时按 corp 报没有这个供应商；选单里那一行带着它的名字
    assert.deepEqual(runModel('corp/glm-4.6'), { provider: 'corp', model: 'glm-4.6' })
    assert.equal(extraModelOption('corp/glm-4.6', false).displayName, '[corp] glm-4.6')
  }))

test('PROVIDERS-006：完整型号落到眼下指向它的那个别名那一行，和从选单里选的一样', () =>
  withProviders(async () => {
    addProviders()
    writeProviderSecret('corp', 'gw-token')
    const anthropic: NativeModelInfo[] = [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Default',
        description: '',
      },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: '' },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Opus (1M context)',
        description: '',
      },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5' },
    ]
    await loadRuntimeModelCatalog(fakeRuntime([], { anthropic }))
    // 不带前缀的、带账号前缀的、只差大小写的都落到 opus 那一行；“默认”那一行跟着 CLI 的默认走，不算
    assert.equal(catalogModelId('claude-opus-5-5'), 'anthropic/opus')
    assert.equal(catalogModelId('anthropic/claude-opus-5-5'), 'anthropic/opus')
    assert.equal(catalogModelId('Claude-Opus-5-5'), 'anthropic/opus')
    assert.equal(catalogModelId('claude-opus-5-5[1m]'), 'anthropic/opus[1m]')
    // 别家的同名型号不落到账号；目录里没有哪一行指向的照原样
    assert.equal(catalogModelId('corp/claude-opus-5-5'), 'corp/claude-opus-5-5')
    assert.equal(catalogModelId('claude-opus-4-6'), 'claude-opus-4-6')
    assert.equal(isSelectableModel('claude-opus-5-5'), true)
  }))
