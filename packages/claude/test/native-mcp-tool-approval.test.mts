// MCP 工具调用的审批。对着真的 Claude Code 和手写的 MCP 服务（fixtures/mcp-count-server.mjs）跑：
// 发给客户端的是原生 codex 那种表单为空的征询，批准、拒绝、“这个会话里都允许”、取消各走一遍，
// 看服务那一头有没有真的被调用。服务的两条来路都走：
//   bridge  会话配置里的服务：适配器自己连，再桥接给 Claude Code
//   cli     项目目录里 .mcp.json 的服务：Claude Code 自己连
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspect } from '../../shared/test/strict-wire.mjs'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const REQUEST = 'mcpServer/elicitation/request'
const OPEN = 'mcp__gate__open'
const SHUT = 'mcp__gate__shut'

type Route = 'bridge' | 'cli'

interface Stage {
  client: ProtocolClient
  model: MockLLM
  threadId: string
  /** 服务那一头真的收到的工具调用，按先后 */
  called(): Promise<string[]>
}

async function withStage(route: Route, run: (stage: Stage) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-approve-'))
  const cwd = join(home, 'project')
  const log = join(home, 'gate.jsonl')
  await mkdir(cwd)
  const server = countServer(log, ['open', 'shut'])
  if (route === 'cli')
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { gate: { type: 'stdio', ...server } } }),
    )
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    // 不是完全访问的档位：MCP 工具每次调用都要问
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      ...(route === 'bridge' ? { config: { mcp_servers: { gate: server } } } : {}),
    })
    await run({
      client,
      model,
      threadId: thread.id,
      called: async () => (await countedServers(log)).flatMap((started) => started.called),
    })
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

const toolResults = (request: any): any[] =>
  request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === 'tool_result')

const shown = (result: any): string => JSON.stringify(result.content)

/** 发给客户端的审批请求：形状逐字段对，再按上游的结构严格校验一遍（多一个字段也算） */
function assertRequests(
  stage: Stage,
  expected: Array<{ turnId: string; tool: string; input: Record<string, unknown> }>,
): any[] {
  const requests = stage.client.trace.filter((entry) => entry.method === REQUEST)
  assert.deepEqual(
    requests.map((request) => request.params),
    expected.map(({ turnId, tool, input }) => ({
      threadId: stage.threadId,
      turnId,
      serverName: 'gate',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: 'session',
        tool_params: input,
        tool_params_display: Object.keys(input)
          .sort()
          .map((name) => ({ name, value: input[name], display_name: name })),
      },
      message: `允许 MCP 服务 gate 运行工具“${tool}”吗？`,
      requestedSchema: { type: 'object', properties: {} },
    })),
  )
  // 信封上的 jsonrpc 是 protocol/compat/baseline.json 里已知的出入，这里只看请求本身
  for (const request of requests)
    assert.deepEqual(
      inspect(JSON.parse(JSON.stringify(request))).filter((finding) => finding.kind !== 'envelope'),
      [],
    )
  // 每条审批有了结果都通知一次
  assert.deepEqual(
    stage.client.trace
      .filter((entry) => entry.method === 'serverRequest/resolved')
      .map((entry) => entry.params),
    requests.map((request) => ({ threadId: stage.threadId, requestId: request.id })),
  )
  return requests
}

/** 回合里那些 MCP 工具调用的条目最后的样子 */
const finished = (stage: Stage, turnId: string): string[] =>
  stage.client.trace
    .filter((entry) => entry.method === 'item/completed' && entry.params.turnId === turnId)
    .map((entry) => entry.params.item)
    .filter((item) => item.type === 'mcpToolCall')
    .map((item) => `${item.server} / ${item.tool} / ${item.status}`)

/** 客户端收到审批时照 answer 答；等着答复的这段时间会话的状态是“在等审批”（和原生 codex 一样） */
function answering(stage: Stage, answer: (params: any) => unknown): void {
  const { client } = stage
  client.onServerRequest = async (method, params) => {
    assert.equal(method, REQUEST)
    const status = client.trace.findLast((entry) => entry.method === 'thread/status/changed')
    assert.deepEqual(status.params.status.activeFlags, ['waitingOnApproval'])
    return answer(params)
  }
}

const INPUT = { zebra: 1, alpha: 'x' }

for (const route of ['bridge', 'cli'] as const) {
  for (const answer of ['accept', 'decline'] as const) {
    test(`MCP-023：MCP 工具调用的审批是带 codex_approval_kind 的征询（${route}），客户端答 ${answer}`, {
      timeout: 60_000,
    }, async () => {
      await withStage(route, async (stage) => {
        const { client, model, threadId } = stage
        answering(stage, () => ({
          action: answer,
          content: answer === 'accept' ? {} : null,
          _meta: null,
        }))
        model.enqueue((request) => {
          assert.ok(
            request.tools.some((tool: any) => tool.name === OPEN),
            'MCP 服务的工具没有交给模型（CLI 等项目里的服务连上最多约两秒）',
          )
          return [call('toolu_gate', OPEN, INPUT)]
        })
        model.enqueue((request) => {
          const results = toolResults(request)
          assert.equal(results.length, 1)
          // 批准了：模型看到的是服务回的东西；拒绝了：模型看到的是“用户拒绝了”
          if (answer === 'accept') assert.match(shown(results[0]), /CALLED open/)
          else assert.match(shown(results[0]), /denied by user/)
          return [{ type: 'text', text: 'APPROVAL_DONE' }]
        })
        const { turn } = await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: '调一次要审批的工具' }],
        })
        assert.equal((await client.completed(turn.id)).status, 'completed')
        assertRequests(stage, [{ turnId: turn.id, tool: 'open', input: INPUT }])
        // 服务那一头：批准了才真的被调用
        assert.deepEqual(await stage.called(), answer === 'accept' ? ['open'] : [])
        assert.deepEqual(finished(stage, turn.id), [
          `gate / open / ${answer === 'accept' ? 'completed' : 'failed'}`,
        ])
        model.assertConsumed()
      })
    })
  }

  test(`MCP-023：答“这个会话里都允许”之后（${route}），同一个工具不再问，换个参数、换个回合也不问；别的工具照问`, {
    timeout: 60_000,
  }, async () => {
    await withStage(route, async (stage) => {
      const { client, model, threadId } = stage
      answering(stage, (params) =>
        params.message.includes('“open”')
          ? { action: 'accept', content: {}, _meta: { persist: 'session' } }
          : { action: 'decline', content: null, _meta: null },
      )
      // 第一个回合：先调一次（问），同一个回合里换个参数再调一次（不问）
      model.enqueue(() => [call('toolu_first', OPEN, { n: 1 })])
      model.enqueue(() => [call('toolu_second', OPEN, { n: 2 })])
      model.enqueue((request) => {
        assert.equal(toolResults(request).length, 2)
        return [{ type: 'text', text: 'SESSION_FIRST' }]
      })
      const first = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: '同一个工具调两次' }],
      })
      assert.equal((await client.completed(first.turn.id)).status, 'completed')
      assert.deepEqual(await stage.called(), ['open', 'open'])
      assertRequests(stage, [{ turnId: first.turn.id, tool: 'open', input: { n: 1 } }])

      // 第二个回合：同一个工具不问；同一个服务的另一个工具照问，这次拒绝
      model.enqueue(() => [call('toolu_third', OPEN, { n: 3 })])
      model.enqueue(() => [call('toolu_shut', SHUT)])
      model.enqueue((request) => {
        const results = toolResults(request)
        assert.equal(results.length, 4)
        assert.match(shown(results[3]), /denied by user/)
        return [{ type: 'text', text: 'SESSION_SECOND' }]
      })
      const second = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: '再调一次，然后调另一个' }],
      })
      assert.equal((await client.completed(second.turn.id)).status, 'completed')
      assert.deepEqual(await stage.called(), ['open', 'open', 'open'])
      assertRequests(stage, [
        { turnId: first.turn.id, tool: 'open', input: { n: 1 } },
        { turnId: second.turn.id, tool: 'shut', input: {} },
      ])
      model.assertConsumed()
    })
  })

  test(`MCP-023：审批答“取消”（${route}），工具没有被调用，回合跟着停`, {
    timeout: 60_000,
  }, async () => {
    await withStage(route, async (stage) => {
      const { client, model, threadId } = stage
      answering(stage, () => ({ action: 'cancel', content: null, _meta: null }))
      model.enqueue(() => [call('toolu_cancel', OPEN)])
      const { turn } = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: '审批的时候取消' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'interrupted')
      assertRequests(stage, [{ turnId: turn.id, tool: 'open', input: {} }])
      assert.deepEqual(await stage.called(), [])
    })
  })
}
