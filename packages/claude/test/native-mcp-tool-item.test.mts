// MCP 工具调用的条目上，服务名和工具名各是什么。对着真的 Claude Code 和手写的 MCP 服务
// （fixtures/mcp-count-server.mjs）跑：两条来路各一个服务，名字都是单看工具名拆不准的那种。
//   bridge  会话配置里的服务 a__b：适配器自己连，再桥接给 Claude Code
//   cli     项目目录里 .mcp.json 的服务 x_：Claude Code 自己连
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// Claude Code 起的名字：mcp__<服务名>__<工具名>，字母数字、下划线、连字符以外的字符换成下划线，双下划线不转义
const CALLS = [
  { name: 'mcp__a__b__c__d', server: 'a__b', tool: 'c__d', called: 'c__d' },
  { name: 'mcp__a__b__do_it_now', server: 'a__b', tool: 'do_it_now', called: 'do.it now' },
  { name: 'mcp__x___e', server: 'x_', tool: 'e', called: 'e' },
]

test('MCP-021：MCP 工具调用的条目报的是服务名和不带前缀的工具名，实时和重读历史一样；自带的工具照旧', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-item-'))
  const cwd = join(home, 'project')
  const logs = { bridge: join(home, 'bridge.jsonl'), cli: join(home, 'cli.jsonl') }
  await mkdir(cwd)
  await writeFile(join(cwd, 'note.txt'), 'NOTE')
  await writeFile(
    join(cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { x_: { type: 'stdio', ...countServer(logs.cli, ['e']) } } }),
  )
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { mcp_servers: { a__b: countServer(logs.bridge, ['c__d', 'do.it now']) } },
    })
    model.enqueue((request) => {
      const offered = request.tools.map((tool: any) => tool.name)
      for (const call of CALLS)
        assert.ok(
          offered.includes(call.name),
          `${call.name} 没有交给模型（CLI 等项目里的服务连上最多约两秒）：${offered}`,
        )
      return [
        ...CALLS.map((call, index) => ({
          type: 'tool_use',
          id: `toolu_mcp_${index}`,
          name: call.name,
          input: {},
        })),
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'note.txt' } },
      ]
    })
    model.enqueue((request) => {
      const results = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'tool_result')
      assert.equal(results.length, CALLS.length + 1)
      return [{ type: 'text', text: 'ITEMS_DONE' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '把几个工具各调一遍' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')

    // 几个工具是并着跑的，谁先结束不一定：按名字排了再比
    const expected = [
      ...CALLS.map((call) => `${call.server} / ${call.tool}`),
      'claude-code / Read note.txt',
    ].sort()
    const named = (items: any[]) =>
      items
        .filter((item) => item.type === 'mcpToolCall')
        .map(({ server, tool }) => `${server} / ${tool}`)
        .sort()
    // 实时：开始和结束各一条，名字一样
    for (const method of ['item/started', 'item/completed'])
      assert.deepEqual(
        named(
          client.trace
            .filter((entry) => entry.method === method && entry.params.turnId === turn.id)
            .map((entry) => entry.params.item),
        ),
        expected,
        method,
      )
    // 重读历史
    const history = await client.request('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
    assert.deepEqual(named(history.thread.turns[0].items), expected)
    assert.ok(
      history.thread.turns[0].items
        .filter((item: any) => item.type === 'mcpToolCall')
        .every((item: any) => item.status === 'completed'),
    )

    // 服务那一头收到的是工具的原名
    const called = [
      ...(await countedServers(logs.bridge)),
      ...(await countedServers(logs.cli)),
    ].flatMap((server) => server.called)
    assert.deepEqual(called.sort(), CALLS.map((call) => call.called).sort())
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
