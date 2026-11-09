// 隔离真实 CLI + 回环假模型：分别核验搜索开、关和默认；不读取个人 Claude 数据。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { dynamicToolName } from '../src/dynamic-tools.mjs'
import { hostClaudeVersion } from '../src/host-claude.mjs'
import { requiredClaudeCli } from './fixtures/claude-cli.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

for (const search of ['true', 'false', 'default']) {
  test(`工具按需加载：真实 CLI 搜索 ${search} 时未标 alwaysLoad 的工具仍可发现调用`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'defer-cli-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      {
        ...(search !== 'default' ? { ENABLE_TOOL_SEARCH: search } : {}),
        CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0',
      },
      { litchExtensions: ['clientTools'], litchClientTools: { namespaces: ['fixture_loading'] } },
    )
    try {
      const calls: string[] = []
      client.onServerRequest = async (method, params) => {
        assert.equal(method, 'item/tool/call')
        calls.push(params.tool)
        return { success: true, contentItems: [{ type: 'inputText', text: 'FIXTURE_OK' }] }
      }
      const names = ['pinned', 'lazy'].map(
        (name) => `mcp__codex_harness_adapter__${dynamicToolName('fixture_loading', name)}`,
      )
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        dynamicTools: [
          {
            type: 'namespace',
            name: 'fixture_loading',
            description: '虚构检索工具',
            tools: [
              {
                type: 'function',
                name: 'pinned',
                description: '常驻回声',
                inputSchema: { type: 'object', properties: {} },
              },
              {
                type: 'function',
                name: 'lazy',
                deferLoading: true,
                description: '按需回声',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        ],
      })
      model.enqueueWithTools(names, () =>
        names.map((name, index) => ({ type: 'tool_use', id: `fixture_${index}`, name, input: {} })),
      )
      model.enqueue(() => [{ type: 'text', text: 'DONE' }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '先检索再调用虚构工具' }],
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', JSON.stringify(completed))
      assert.deepEqual(calls.sort(), ['lazy', 'pinned'])
      model.assertConsumed()
      const first = model.requests[0]
      assert.ok(first)
      const tools = first.tools
        .map((tool: any) => ({ name: tool.name, defer: tool.defer_loading === true }))
        .filter((tool: any) => names.includes(tool.name) || tool.name === 'ToolSearch')
      console.log(JSON.stringify({ search, tools, searched: model.toolSearchRequests.length }))
      assert.equal(tools.find((tool: any) => tool.name === names[0])?.defer, false)
      if (search === 'false') assert.equal(model.toolSearchRequests.length, 0)
      if (search === 'true') assert.equal(model.toolSearchRequests.length, 1)
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

for (const [mode, search, supportsSearch] of [
  ['auto', 'true', true],
  ['auto', '', false],
  ['on', '', true],
  ['off', 'true', false],
] as const) {
  test(`Litch 默认分层端到端：${mode}/${search || '未设置'}，常驻工具直接调用，按需工具检索后调用`, {
    timeout: 100_000,
  }, async () => {
    // CI 的旧 CLI 必须验证 auto 保守回退；on 不受自动识别门槛限制，仍验证真实检索。
    const version = hostClaudeVersion(requiredClaudeCli(), '0.0.0').split(' ')[0]
    const expectSearch = supportsSearch && (mode !== 'auto' || isVersionAtLeast(version, '2.1.305'))
    const home = await mkdtemp(join(tmpdir(), 'litch-defer-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      {
        CHA_CLAUDE_TOOL_LOADING: mode,
        ...(search ? { ENABLE_TOOL_SEARCH: search } : {}),
        CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0',
      },
      {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_tasks', 'litch_sessions'] },
      },
    )
    try {
      const calls: string[] = []
      client.onServerRequest = async (method, params) => {
        assert.equal(method, 'item/tool/call')
        calls.push(params.namespace)
        return { success: true, contentItems: [{ type: 'inputText', text: 'LITCH_FIXTURE_OK' }] }
      }
      const namespaces = ['litch_sessions', 'litch_tasks']
      const names = namespaces.map(
        (namespace) => `mcp__codex_harness_adapter__${dynamicToolName(namespace, 'list')}`,
      )
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        // 正式工具合同，执行端返回虚构只读结果；不访问用户的会话或任务。
        dynamicTools: [SESSION_TOOLS, TASKS_TOOLS],
      })
      if (expectSearch)
        model.enqueue(() => [
          {
            type: 'tool_use',
            id: 'discover_tasks',
            name: 'ToolSearch',
            input: { query: 'litch_tasks list', max_results: 5 },
          },
        ])
      model.enqueueWithTools(names, () =>
        names.map((name, index) => ({ type: 'tool_use', id: `layer_${index}`, name, input: {} })),
      )
      model.enqueue(() => [{ type: 'text', text: 'DONE' }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '读取会话和任务列表' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      assert.deepEqual(calls.sort(), ['litch_sessions', 'litch_tasks'])
      assert.equal(model.toolSearchRequests.length, 0, '命名空间检索已得到定义，无须按哈希名字补搜')
      const first = model.requests[0]
      assert.ok(first)
      assert.ok(first.tools.some((tool: any) => tool.name === names[0] && !tool.defer_loading))
      const taskTool = first.tools.find((tool: any) => tool.name === names[1])
      if (expectSearch) {
        assert.ok(first.tools.some((tool: any) => tool.name === 'ToolSearch'))
        assert.ok(!taskTool || taskTool.defer_loading === true, '按需工具不能常驻首个请求')
        assert.ok(
          model.requests.some((request) =>
            JSON.stringify(request.messages).includes('discover_tasks'),
          ),
          '模型必须收到检索结果后再调用按需工具',
        )
      } else {
        assert.ok(taskTool && !taskTool.defer_loading, '回退和 off 模式的工具必须全部常驻')
      }
      assert.equal(
        JSON.stringify(first.system).includes('Additional tools are available in: litch_tasks'),
        expectSearch,
      )
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
