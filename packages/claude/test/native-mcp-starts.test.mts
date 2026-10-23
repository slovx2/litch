// 用户级配置（.claude.json）里的 stdio MCP 服务一共被起几份、各是谁起的。
// 这份配置适配器和 Claude Code 都读得到：适配器桥接的那一份才是工具调用落到的地方，
// Claude Code 不该再照自己的配置连一份。服务是 fixtures/mcp-count-server.mjs，每被起一次记一行。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const ADAPTER = 'codex-harness-adapter'
const CLI = 'claude-code'
const STARTUP = 'mcpServer/startupStatus/updated'

interface Stage {
  client: ProtocolClient
  model: MockLLM
  cwd: string
  /** 用户级配置里的那个服务（counted）起过的每一份 */
  counted(): ReturnType<typeof countedServers>
  /** 只写在项目 .mcp.json 里的那个服务（solo）起过的每一份 */
  solo(): ReturnType<typeof countedServers>
}

async function withStage(
  run: (stage: Stage) => Promise<void>,
  // 握手时退订的通知。缺省一个也不退订
  optOut: string[] = [],
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-starts-'))
  const cwd = join(home, 'project')
  const logs = { counted: join(home, 'counted.jsonl'), solo: join(home, 'solo.jsonl') }
  await mkdir(cwd)
  // 被测进程的 Claude 配置目录是 <home>/claude，用户级的 MCP 服务写在它的 .claude.json 里
  await mkdir(join(home, 'claude'))
  await writeFile(
    join(home, 'claude', '.claude.json'),
    JSON.stringify({ mcpServers: { counted: { type: 'stdio', ...countServer(logs.counted) } } }),
  )
  // 只有 Claude Code 知道的服务：适配器不管它，照旧由 CLI 自己连
  await writeFile(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: { solo: { type: 'stdio', ...countServer(logs.solo, ['only']) } },
    }),
  )
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    // 回合结束 CLI 就退：第二个回合起新 CLI，才看得出它会不会自己再连一份
    { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0' },
    optOut.length ? { optOutNotificationMethods: optOut } : null,
  )
  try {
    // 握手之后适配器把配置里的服务探一遍：等它探完再往下，后面数的才是回合里起的
    if (!optOut.includes(STARTUP))
      await client.notification(
        STARTUP,
        (params) => params.name === 'counted' && params.status === 'ready',
      )
    await run({
      client,
      model,
      cwd,
      counted: () => countedServers(logs.counted),
      solo: () => countedServers(logs.solo),
    })
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const toolResults = (request: any): any[] =>
  request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === 'tool_result')

test('MCP-022：用户级配置里的 stdio 服务只起一份（适配器桥接的那一份，第二个回合接着用），Claude Code 不再自己连一份', {
  timeout: 60_000,
}, async () => {
  await withStage(async ({ client, model, cwd, counted, solo }) => {
    // 握手后的探测：起一份，探完就关
    const probed = await counted()
    assert.deepEqual(
      probed.map(({ client, called }) => ({ client, called })),
      [{ client: ADAPTER, called: [] }],
    )
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    for (const round of [1, 2]) {
      model.enqueue((request) => {
        const offered = request.tools.map((tool: any) => tool.name)
        for (const name of ['mcp__counted__echo', 'mcp__solo__only'])
          assert.ok(offered.includes(name), `${name} 没有交给模型：${offered}`)
        return [
          { type: 'tool_use', id: `toolu_counted_${round}`, name: 'mcp__counted__echo', input: {} },
          { type: 'tool_use', id: `toolu_solo_${round}`, name: 'mcp__solo__only', input: {} },
        ]
      })
      model.enqueue(async (request) => {
        assert.equal(toolResults(request).length, 2 * round)
        // 回合进行中：探测之后只起过桥接的那一份，第二个回合接着用它（CLI 进程每回合换一个，连接留着）
        const running = (await counted()).slice(1)
        assert.deepEqual(
          running.map(({ client, called, closed }) => ({ client, called, closed })),
          [{ client: ADAPTER, called: Array(round).fill('echo'), closed: false }],
        )
        return [{ type: 'text', text: 'STARTS_DONE' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '两个服务的工具各调一次' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
    }
    // 两个回合下来：探测一份、回合共用一份，没有一份是 Claude Code 连的
    const all = await counted()
    assert.deepEqual(
      all.map((server) => server.client),
      [ADAPTER, ADAPTER],
    )
    // 只有 CLI 知道的那个服务不受影响：每个回合由 Claude Code 自己连一份
    assert.deepEqual(
      (await solo()).map(({ client, called }) => ({ client, called })),
      [
        { client: CLI, called: ['only'] },
        { client: CLI, called: ['only'] },
      ],
    )
    model.assertConsumed()
  })
})

test('MCP-022：在会话配置里停用的用户级服务，Claude Code 也不会自己把它连上', {
  timeout: 60_000,
}, async () => {
  await withStage(async ({ client, model, cwd, counted, solo }) => {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { mcp_servers: { counted: { enabled: false } } },
    })
    const listed = await client.request('mcpServerStatus/list', { threadId: thread.id })
    assert.deepEqual(listed.data, [])
    model.enqueue((request) => {
      const offered = request.tools.map((tool: any) => tool.name)
      assert.ok(!offered.some((name: string) => name.startsWith('mcp__counted__')), `${offered}`)
      // 项目里的服务照常：调它一次，说明 CLI 连服务的那一步确实走过了
      assert.ok(offered.includes('mcp__solo__only'), `${offered}`)
      return [{ type: 'tool_use', id: 'toolu_solo', name: 'mcp__solo__only', input: {} }]
    })
    model.enqueue(() => [{ type: 'text', text: 'DISABLED_DONE' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '停用的服务不该出现' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    // 起过的只有握手后探测的那一份（探测看的是没有会话配置时的那份配置）
    assert.deepEqual(
      (await counted()).map((server) => server.client),
      [ADAPTER],
    )
    assert.deepEqual(
      (await solo()).map(({ client, called }) => ({ client, called })),
      [{ client: CLI, called: ['only'] }],
    )
    model.assertConsumed()
  })
})

test('MCP-022：退订了启动状态通知的连接，握手之后不为它把服务探一遍；列服务状态照常，每列一次连一次', {
  timeout: 60_000,
}, async () => {
  await withStage(
    async ({ client, counted }) => {
      // 探测要是做了，是握手一完就开始的，列完两次状态时它那一份早就起过了
      for (const round of [1, 2]) {
        const listed = await client.request('mcpServerStatus/list', { limit: 100 })
        assert.deepEqual(
          listed.data.map((server: any) => [server.name, Object.keys(server.tools)]),
          [['counted', ['echo']]],
        )
        const started = await counted()
        assert.deepEqual(
          started.map((server) => server.client),
          Array(round).fill(ADAPTER),
        )
        // 列完就关，不留着
        assert.ok(started.every((server) => server.closed))
      }
      assert.deepEqual(
        client.trace.filter((entry) => entry.method === STARTUP),
        [],
      )
    },
    [STARTUP],
  )
})
