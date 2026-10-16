import assert from 'node:assert/strict'
import test from 'node:test'
import { sdkMcpServers } from '../src/mcp-config.mjs'
import {
  allSelectableModelOptions,
  defaultSelectableModelId,
  isSelectableModel,
  loadRuntimeModelCatalog,
  modelNameFromResolved,
  normalizeSelectableModelId,
} from '../src/server-helpers.mjs'
import type { ClaudeRuntime, NativeModelInfo } from '../src/types.mjs'
import { resolveClaudeModel } from '../src/util.mjs'

function withModelEnvironment(run: () => Promise<void> | void) {
  const keys = ['CHA_CLAUDE_MODELS', 'CHA_CLAUDE_DEFAULT_MODEL']
  const previous = keys.map((key) => process.env[key])
  return (async () => {
    try {
      for (const key of keys) delete process.env[key]
      await run()
    } finally {
      for (const [index, key] of keys.entries()) {
        if (previous[index] == null) delete process.env[key]
        else process.env[key] = previous[index]
      }
    }
  })()
}

test('原生目录取得前只提供默认项，普通及标题请求都沿用原生 Claude 配置', () =>
  withModelEnvironment(() => {
    assert.equal(defaultSelectableModelId(), 'default')
    assert.deepEqual(
      allSelectableModelOptions().map((option) => [option.id, option.isDefault]),
      [['default', true]],
    )
    assert.equal(resolveClaudeModel('default'), null)
    assert.equal(resolveClaudeModel('claude-default'), null)
    assert.equal(resolveClaudeModel('claude-default', 'summary'), null)
    assert.equal(resolveClaudeModel('opus'), 'opus')
    assert.equal(resolveClaudeModel('opus[1m]'), 'opus[1m]')
    process.env.CHA_CLAUDE_MODELS = 'custom-a,custom-b'
    assert.equal(defaultSelectableModelId(), 'custom-a')
    assert.deepEqual(
      allSelectableModelOptions().map((option) => option.id),
      ['custom-a', 'custom-b'],
    )
  }))

test('模型目录取自运行时原生列表；目录外的 Claude 别名与型号仍可选', () =>
  withModelEnvironment(async () => {
    const catalog: NativeModelInfo[] = [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Use the default model (currently Opus 5.5 (1M context))',
        supportedEffortLevels: ['low', 'max'],
      },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5' },
    ]
    const runtime = { supportedModels: async () => catalog } as unknown as ClaudeRuntime
    await loadRuntimeModelCatalog(runtime)
    assert.deepEqual(
      allSelectableModelOptions().map((option) => [option.id, option.sdkModel, option.isDefault]),
      [
        ['default', null, true],
        ['sonnet', 'sonnet', false],
      ],
    )
    assert.deepEqual(allSelectableModelOptions()[0]?.efforts, ['low', 'max'])
    assert.equal(allSelectableModelOptions()[0]?.displayName, 'Default · Opus 5.5 (1M context)')
    assert.equal(allSelectableModelOptions()[1]?.displayName, 'Sonnet')
    for (const [resolved, name] of [
      ['claude-opus-5-5[1m]', 'Opus 5.5 (1M context)'],
      ['claude-fable-5-1', 'Fable 5.1'],
      ['claude-sonnet-5', 'Sonnet 5'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
      ['claude-3-5-sonnet-20241022', null],
      [undefined, null],
    ] as const)
      assert.equal(modelNameFromResolved(resolved), name, String(resolved))
    for (const model of ['opus', 'opus[1m]', 'claude-fable-5-1', 'sonnet-1m', 'claude-default'])
      assert.equal(isSelectableModel(model), true, model)
    for (const model of ['runtime-agent-http', 'gpt-5', ''])
      assert.equal(isSelectableModel(model), false, model)
    assert.equal(normalizeSelectableModelId('opus', 'sonnet'), 'opus')
    assert.equal(normalizeSelectableModelId('SONNET', 'default'), 'sonnet')
    assert.equal(normalizeSelectableModelId('runtime-agent-http', 'sonnet'), 'sonnet')
  }))

test('MCP 配置中未翻译的 Codex 字段被忽略，审批跟随会话权限', () => {
  const servers = sdkMcpServers({
    docs: {
      url: 'https://example.com/mcp',
      default_tools_approval_mode: 'approve',
      tools: { search: { approval_mode: 'prompt' } },
      disabled_tools: ['write'],
    },
  })
  assert.deepEqual(Object.keys(servers), ['docs'])
  assert.equal(servers.docs.url, 'https://example.com/mcp')
})
