// MCP 征询对着一个手写的、真的 MCP 服务跑整条路（fixtures/mcp-elicit-server.mjs，不用 MCP 库）：
// 客户端发消息 → 假模型让 Claude Code 调工具 → 服务发 elicitation/create → 适配器发服务端请求 →
// 客户端答复 → 服务收到 → 工具结果回到模型。服务那一头线上来往的每一条都有记录，两头对着断言。
//
// 征询到客户端有三条来路，发给客户端的请求应当一个样：
//   bridge  会话配置里的服务（config.mcp_servers；用户级配置也走这条）：适配器自己当 MCP 客户端
//   cli     项目目录里 .mcp.json 的服务：Claude Code 自己当 MCP 客户端，征询经 SDK 的回调过来
//   管理接口 客户端直接调工具（mcpServer/tool/call）：不经模型，没有回合
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { inspect } from '../../shared/test/strict-wire.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const REQUEST = 'mcpServer/elicitation/request'
const TOOL = 'mcp__forms__ask_form'
const MESSAGE = '请填写发布信息'
// 有代表性的一张表：字、数、是否、单选各一栏，两栏必填
const FORM = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '名字', description: '发布的名字', minLength: 1, maxLength: 40 },
    count: { type: 'integer', title: '份数', minimum: 1, maximum: 10 },
    notify: { type: 'boolean', title: '通知', default: false },
    level: { type: 'string', title: '级别', enum: ['low', 'high'], enumNames: ['低', '高'] },
  },
  required: ['name', 'level'],
}
const FILLED = { name: '甲', count: 3, notify: true, level: 'high' }

type Route = 'bridge' | 'cli'
type Answer = 'accept' | 'decline' | 'cancel'
/** 服务那一头记下的一条：谁发的、线上的原样。from 是 fixture 的那条是它自己记的事（连接关了） */
interface Wire {
  from: 'client' | 'server' | 'fixture'
  message: any
  /** 记这一条的那个服务进程 */
  pid: number
}

interface Stage {
  client: ProtocolClient
  model: MockLLM
  threadId: string
  /** 服务那一头到现在记下的全部 */
  wire(): Promise<Wire[]>
}

async function withStage(route: Route, run: (stage: Stage) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-form-'))
  const cwd = join(home, 'project')
  const log = join(home, 'mcp-wire.jsonl')
  await mkdir(cwd)
  const server = {
    command: process.execPath,
    args: [resolve('packages/claude/test/fixtures/mcp-elicit-server.mjs')],
    env: {
      FIXTURE_LOG_PATH: log,
      FIXTURE_ELICITATION: JSON.stringify({
        mode: 'form',
        message: MESSAGE,
        requestedSchema: FORM,
      }),
    },
  }
  // CLI 自己连的那条路：服务只写在项目的配置文件里，不经协议给适配器
  if (route === 'cli')
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { forms: { type: 'stdio', ...server } } }),
    )
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(route === 'bridge' ? { config: { mcp_servers: { forms: server } } } : {}),
    })
    await run({
      client,
      model,
      threadId: thread.id,
      wire: async () =>
        (await readFile(log, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Wire),
    })
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 等服务那一头记下符合条件的一条。等不到就失败，不无限挂着 */
async function awaitWire(stage: Stage, wanted: (entry: Wire) => boolean): Promise<Wire> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = (await stage.wire()).find(wanted)
    if (found) return found
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`服务那一头没有等到要的记录：${JSON.stringify(await stage.wire())}`)
}

/** 这个进程还在不在 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 发给客户端的那条征询请求：形状逐字段对，再按上游的结构严格校验一遍（多一个字段也算） */
function assertRequest(stage: Stage, turnId: string | null): any {
  const requests = stage.client.trace.filter((entry) => entry.method === REQUEST)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].params, {
    threadId: stage.threadId,
    turnId,
    serverName: 'forms',
    message: MESSAGE,
    mode: 'form',
    requestedSchema: FORM,
  })
  // 信封上的 jsonrpc 是 protocol/compat/baseline.json 里已知的出入，这里只看请求本身
  assert.deepEqual(
    inspect(JSON.parse(JSON.stringify(requests[0]))).filter(
      (finding) => finding.kind !== 'envelope',
    ),
    [],
  )
  return requests[0]
}

/** 握手时是谁在当 MCP 客户端、它有没有声明会答征询 */
async function assertMcpClient(stage: Stage, name: string, elicitation: unknown): Promise<void> {
  const greeted = (await stage.wire()).filter(
    (entry) => entry.from === 'client' && entry.message.method === 'initialize',
  )
  // 桥接的那条路上适配器列服务状态时还会另连一次，所以不数次数，只看每一次都是它
  assert.ok(greeted.length >= 1)
  for (const entry of greeted) {
    assert.equal(entry.message.params.clientInfo.name, name)
    assert.deepEqual(entry.message.params.capabilities.elicitation, elicitation)
  }
}

/** 征询有了结果的通知恰好一条，而且在回合结束之前 */
function assertResolved(stage: Stage, request: any): void {
  const { trace } = stage.client
  const resolved = trace.filter((entry) => entry.method === 'serverRequest/resolved')
  assert.equal(resolved.length, 1)
  assert.deepEqual(resolved[0].params, { threadId: stage.threadId, requestId: request.id })
  const ended = trace.findIndex((entry) => entry.method === 'turn/completed')
  assert.ok(trace.indexOf(request) < trace.indexOf(resolved[0]))
  assert.ok(ended < 0 || trace.indexOf(resolved[0]) < ended, '征询的结果要先于回合的终态')
}

// 两条路上 MCP 客户端是谁、握手时怎么声明的。CLI 那条是 Claude Code 自己报的（2.1.282 只声明表单）
const MCP_CLIENT: Record<Route, [string, unknown]> = {
  bridge: ['codex-harness-adapter', { form: {}, url: {} }],
  cli: ['claude-code', {}],
}
// 三种答法各自到服务那一头时线上的样子
const ANSWERED: Record<Answer, unknown> = {
  accept: { action: 'accept', content: FILLED },
  decline: { action: 'decline' },
  cancel: { action: 'cancel' },
}

for (const route of ['bridge', 'cli'] as const) {
  for (const answer of ['accept', 'decline', 'cancel'] as const) {
    test(`MCP-004：手写的真 MCP 服务发表单征询（${route}），客户端答 ${answer}，两头线上的内容对得上`, {
      timeout: 60_000,
    }, async () => {
      await withStage(route, async (stage) => {
        const { client, model, threadId } = stage
        let asked = 0
        client.onServerRequest = async (method) => {
          assert.equal(method, REQUEST)
          asked++
          // 等着答复的这段时间，会话的状态是“在等用户”
          const status = client.trace.findLast((entry) => entry.method === 'thread/status/changed')
          assert.deepEqual(status.params.status.activeFlags, ['waitingOnUserInput'])
          return { action: answer, content: answer === 'accept' ? FILLED : null, _meta: null }
        }
        model.enqueue((request) => {
          assert.ok(
            request.tools.some((tool: any) => tool.name === TOOL),
            'MCP 服务的工具没有交给模型（CLI 等项目里的服务连上最多约两秒）',
          )
          return [{ type: 'tool_use', id: 'toolu_form', name: TOOL, input: {} }]
        })
        model.enqueue((request) => {
          const results = request.messages
            .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
            .filter((block: any) => block.type === 'tool_result')
          assert.equal(results.length, 1)
          assert.notEqual(results[0].is_error, true)
          // 服务把收到的答复原样写进了工具结果，模型看到的就是它
          const shown = [results[0].content].flat().map((block: any) => block.text ?? block)
          assert.ok(
            shown.some((text) => text.includes(`ELICITED ${JSON.stringify(ANSWERED[answer])}`)),
            JSON.stringify(results[0]),
          )
          return [{ type: 'text', text: 'FORM_DONE' }]
        })
        const { turn } = await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: '把表单填了' }],
        })
        const completed = await client.completed(turn.id)
        assert.equal(completed.status, 'completed', JSON.stringify(completed))
        assert.equal(asked, 1)
        const request = assertRequest(stage, turn.id)
        assertResolved(stage, request)
        await assertMcpClient(stage, ...MCP_CLIENT[route])
        // 服务那一头：发出去的征询只有一条，收到的答复就是客户端答的那一种
        const wire = await stage.wire()
        const sent = wire.filter(
          (entry) => entry.from === 'server' && entry.message.method === 'elicitation/create',
        )
        assert.equal(sent.length, 1)
        const replies = wire.filter(
          (entry) => entry.from === 'client' && entry.message.id === sent[0]?.message.id,
        )
        assert.equal(replies.length, 1)
        assert.deepEqual(replies[0]?.message.result, ANSWERED[answer])
        model.assertConsumed()
      })
    })
  }

  test(`MCP-004：回合被打断时挂着的表单征询（${route}）先收场，迟到的“提交”到不了服务`, {
    timeout: 60_000,
  }, async () => {
    await withStage(route, async (stage) => {
      const { client, model, threadId } = stage
      const requested = deferred()
      const release = deferred()
      const replied = deferred()
      client.onServerRequest = async (method) => {
        assert.equal(method, REQUEST)
        requested.resolve()
        await release.promise
        replied.resolve()
        return { action: 'accept', content: FILLED, _meta: null }
      }
      model.enqueue(() => [{ type: 'tool_use', id: 'toolu_pending', name: TOOL, input: {} }])
      try {
        const { turn } = await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: '表单还没填就打断' }],
        })
        await requested.promise
        await client.request('turn/interrupt', { threadId, turnId: turn.id })
        assert.equal((await client.completed(turn.id)).status, 'interrupted')
        assertResolved(stage, assertRequest(stage, turn.id))
        // 服务那一头：那次工具调用被取消了
        const call = await awaitWire(
          stage,
          (entry) => entry.from === 'client' && entry.message.method === 'tools/call',
        )
        const cancelled = (entry: Wire) =>
          entry.from === 'client' &&
          entry.message.method === 'notifications/cancelled' &&
          entry.message.params.requestId === call.message.id
        if (route === 'bridge') {
          await awaitWire(stage, cancelled)
          // 桥接的那条路上，打断会连同这次的 MCP 连接一起关掉，征询随连接作废、不另外答复
          const closed = await awaitWire(stage, (entry) => entry.from === 'fixture')
          assert.equal(closed.message.unanswered.length, 1)
        } else {
          // CLI 自己连的那条路上，取消由 CLI 发。机器很慢时 CLI 可能在时限内没确认打断，适配器就把它
          // 连同它起的服务一起结束：这时服务收不到取消，但它已经不在了，迟到的“提交”一样到不了
          const deadline = Date.now() + 20_000
          while (!(await stage.wire()).some(cancelled) && alive(call.pid)) {
            if (Date.now() > deadline)
              throw new Error(
                `那次工具调用没有被取消，服务（进程 ${call.pid}）也还在：${JSON.stringify(await stage.wire())}`,
              )
            await new Promise((done) => setTimeout(done, 20))
          }
        }
        release.resolve()
        await replied.promise
        const history = await client.request('thread/read', { threadId, includeTurns: true })
        assert.equal(history.thread.turns[0].status, 'interrupted')
        assert.ok(history.thread.turns[0].items.every((item: any) => item.status !== 'inProgress'))
        // 迟到的“提交”被丢掉：服务收到的要么是取消（CLI 自己答的），要么什么都没收到
        const answers = (await stage.wire()).filter(
          (entry) => entry.from === 'client' && entry.message.method === undefined,
        )
        for (const entry of answers) assert.deepEqual(entry.message.result, { action: 'cancel' })
        assert.equal(model.requests.length, 1)
        model.assertConsumed()
      } finally {
        release.resolve()
      }
    })
  })
}

test('MCP-004：客户端直接调工具（mcpServer/tool/call）时的表单征询不属于任何回合，答复照样到服务', {
  timeout: 60_000,
}, async () => {
  await withStage('bridge', async (stage) => {
    const { client, model, threadId } = stage
    client.onServerRequest = async (method) => {
      assert.equal(method, REQUEST)
      return { action: 'accept', content: FILLED, _meta: null }
    }
    const called = await client.request('mcpServer/tool/call', {
      threadId,
      server: 'forms',
      tool: 'ask_form',
      arguments: {},
    })
    assert.equal(called.content[0].text, `ELICITED ${JSON.stringify(ANSWERED.accept)}`)
    assertResolved(stage, assertRequest(stage, null))
    await assertMcpClient(stage, ...MCP_CLIENT.bridge)
    assert.equal(model.requests.length, 0)
  })
})
