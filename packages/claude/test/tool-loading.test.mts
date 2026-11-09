import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { dynamicToolServer } from '../src/dynamic-tools.mjs'
import { goalToolServer } from '../src/goal-tools.mjs'
import { permissionToolServer } from '../src/permission-tools.mjs'
import {
  deferredToolHint,
  loadingOverrides,
  toolLoadingPolicy,
  toolSearchAvailable,
} from '../src/tool-loading.mjs'

const model = 'claude-sonnet-4-6'
const active = { ENABLE_TOOL_SEARCH: 'true' }
test('auto 仅对确认的版本、模型和环境生效，未知条件全部常驻', () => {
  assert.equal(toolSearchAvailable('2.1.316', {}, model), true)
  assert.equal(
    toolSearchAvailable('2.1.305', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'opus[1m]'),
    true,
  )
  for (const [version, env, selected] of [
    [null, active, model],
    ['2.1.316', active, null],
    ['garbage', active, model],
    ['2.1.304', active, model],
    ['2.1.316-beta.1', active, model],
    ['2.1.316', { ENABLE_TOOL_SEARCH: 'false' }, model],
    ['2.1.316', { ENABLE_TOOL_SEARCH: 'invalid' }, model],
    ['2.1.316', { ANTHROPIC_BASE_URL: 'https://gateway.invalid' }, model],
    ['2.1.316', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.invalid' }, model],
    ['2.1.316', { ...active, CLAUDE_CODE_USE_VERTEX: '1' }, model],
    ['2.1.316', { ...active, CLAUDE_CODE_USE_BEDROCK: 'true' }, model],
    ['2.1.316', { ...active, CLAUDE_CODE_USE_FOUNDRY: '1' }, model],
    ['2.1.316', { ...active, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' }, model],
    ['2.1.316', active, 'custom-model'],
    ['2.1.316', active, 'claude-haiku-3-5'],
  ] as const)
    assert.equal(
      toolSearchAvailable(version, env, selected),
      false,
      JSON.stringify([version, env, selected]),
    )
  assert.equal(
    toolSearchAvailable(
      '2.1.316',
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ENABLE_TOOL_SEARCH: 'auto:5' },
      model,
    ),
    true,
  )
})

test('默认分层、覆盖优先级和调用方逐工具声明；不改原定义', () => {
  const defaults = toolLoadingPolicy('2.1.316', active, model)
  for (const namespace of [
    'litch_browser',
    'litch_computer',
    'litch_tasks',
    'litch_repository',
    'litch_config',
  ])
    assert.equal(defaults(namespace, 'read'), true)
  for (const namespace of [
    'litch_sessions',
    'litch_manager',
    'goal-tools',
    'permission-tools',
    'litch_automation',
    'litch_machine',
    'litch_background',
    'litch_shell',
    'unknown',
  ])
    assert.equal(defaults(namespace, 'read'), false)
  const declared = Object.freeze({ deferLoading: false })
  const env = {
    ...active,
    CHA_CLAUDE_TOOL_LOADING_OVERRIDES:
      'litch_browser=always,litch_browser.navigate=defer,goal-tools=defer,permission-tools=defer,litch_sessions.read=defer',
  }
  const policy = toolLoadingPolicy('2.1.316', env, model)
  assert.equal(policy('litch_browser', 'snapshot'), false)
  assert.equal(policy('litch_browser', 'navigate'), true)
  assert.equal(policy('litch_browser', 'navigate', declared), false)
  assert.equal(policy('litch_sessions', 'read'), true)
  assert.equal(policy('goal-tools', 'get_goal'), true)
  assert.equal(policy('permission-tools', 'request_permissions'), true)
  for (const mode of ['auto', 'off']) {
    const fallback = toolLoadingPolicy(null, { ...env, CHA_CLAUDE_TOOL_LOADING: mode }, model)
    assert.equal(fallback('goal-tools', 'get_goal'), false)
    assert.equal(fallback('litch_browser', 'navigate'), false)
    assert.equal(fallback('external', 'read', { deferLoading: true }), true)
    assert.equal(fallback('external', 'read', { defer_loading: true }), true)
    assert.equal(fallback('external', 'read', { deferLoading: 'true' }), false)
  }
  assert.equal(
    toolLoadingPolicy(null, { CHA_CLAUDE_TOOL_LOADING: 'on' }, 'unknown')('litch_browser', 'read'),
    true,
  )
  assert.throws(() => loadingOverrides('litch_browser=false'), /格式无效/)
  assert.throws(() => toolLoadingPolicy(null, { CHA_CLAUDE_TOOL_LOADING: 'wrong' }, null), /auto/)
  assert.equal(deferredToolHint([]), '')
  assert.match(
    deferredToolHint([{ namespace: 'litch_tasks', name: 'list' }]),
    /ToolSearch.*namespace/s,
  )
})

test('动态、目标、权限 MCP 共用配置，不把自有工具写死常驻', async () => {
  const loading = toolLoadingPolicy(
    '2.1.316',
    {
      ...active,
      CHA_CLAUDE_TOOL_LOADING_OVERRIDES: 'goal-tools.get_goal=defer,permission-tools=defer',
    },
    model,
  )
  const handlers = {
    onEvent: async () => {},
    onPermissionRequest: async () => ({ decision: 'decline' as const }),
  }
  const servers = [
    dynamicToolServer(
      [
        {
          type: 'namespace',
          name: 'litch_tasks',
          tools: [
            {
              type: 'function',
              name: 'list',
              description: '列任务',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      ],
      handlers,
      () => 'fixture',
      loading,
    ),
    goalToolServer(handlers, () => 'fixture', loading),
    permissionToolServer(
      async () => {
        throw new Error('不调用权限工具')
      },
      () => 'fixture',
      loading,
    ),
  ]
  const all: unknown[][] = []
  for (const server of servers) {
    const client = new Client({ name: 'loading', version: '1.0.0' })
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair()
      await server.instance.connect(remote)
      await client.connect(local)
      all.push((await client.listTools()).tools.map((tool) => tool._meta?.['anthropic/alwaysLoad']))
    } finally {
      await client.close()
      await server.instance.close()
    }
  }
  assert.deepEqual(all, [[undefined], [undefined, true, true], [undefined]])
})
