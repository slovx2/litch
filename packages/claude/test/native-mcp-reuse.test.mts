// MCP 连接跨回合复用（native-mcp-pool.mts）：真的 Claude Code CLI、回环上的假模型、手写的 stdio 服务。
// 服务每被起一次是一份（按进程号认，fixtures/mcp-count-server.mjs 和 mcp-elicit-server.mjs 都记进程号），
// 所以“第二个回合有没有重连”就是数份数。会话配置里的服务不在握手后的探测范围内，数到的都是回合起的。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Daemon } from './fixtures/daemon.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const STARTUP = 'mcpServer/startupStatus/updated'

interface Stage {
  client: ProtocolClient
  model: MockLLM
  home: string
  cwd: string
  log: string
}

async function withStage(
  switches: Record<string, string>,
  run: (stage: Stage) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-reuse-'))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  await mkdir(join(home, 'claude'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', switches, {
    // 握手后的探测另起一份，和回合里的混在一起不好数
    optOutNotificationMethods: [STARTUP],
  })
  try {
    await run({ client, model, home, cwd, log: join(home, 'counted.jsonl') })
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function startThread(stage: Stage, servers: Record<string, unknown> | null): Promise<string> {
  const { thread } = await stage.client.request('thread/start', {
    cwd: stage.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...(servers ? { config: { mcp_servers: servers } } : {}),
  })
  return thread.id
}

/** 一个回合：调一次工具再收尾。返回回合号 */
async function callTool(stage: Stage, threadId: string, tool: string, id: string): Promise<string> {
  stage.model.enqueue(() => [{ type: 'tool_use', id, name: tool, input: {} }])
  stage.model.enqueue(() => [{ type: 'text', text: 'DONE' }])
  const { turn } = await stage.client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `调一次 ${tool}` }],
  })
  assert.equal((await stage.client.completed(turn.id)).status, 'completed')
  stage.model.assertConsumed()
  return turn.id
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`等不到预期的状态：${JSON.stringify(value)}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

const shape = (servers: Awaited<ReturnType<typeof countedServers>>) =>
  servers.map(({ called, closed }) => ({ called, closed }))

test('MCP-024：同一线程第二个回合接着用上一回合的连接（不重起服务）；别的线程不共用；线程归档时关掉', {
  timeout: 90_000,
}, async () => {
  await withStage({}, async (stage) => {
    const counted = { counted: countServer(stage.log) }
    const first = await startThread(stage, counted)
    await callTool(stage, first, 'mcp__counted__echo', 'toolu_1')
    await callTool(stage, first, 'mcp__counted__echo', 'toolu_2')
    // 两个回合是两个 CLI 进程，服务只有一份，两次调用都落在它身上，回合结束后它还在
    assert.deepEqual(shape(await countedServers(stage.log)), [
      { called: ['echo', 'echo'], closed: false },
    ])
    const second = await startThread(stage, counted)
    await callTool(stage, second, 'mcp__counted__echo', 'toolu_3')
    assert.deepEqual(shape(await countedServers(stage.log)), [
      { called: ['echo', 'echo'], closed: false },
      { called: ['echo'], closed: false },
    ])
    await stage.client.request('thread/archive', { threadId: first })
    assert.deepEqual(
      shape(
        await eventually(
          () => countedServers(stage.log),
          (all) => all[0]?.closed === true,
        ),
      ),
      [
        { called: ['echo', 'echo'], closed: true },
        { called: ['echo'], closed: false },
      ],
    )
  })
})

test('MCP-024：服务配置变了（用户级配置改了环境变量）下一个回合重建连接，旧的那份关掉', {
  timeout: 90_000,
}, async () => {
  await withStage({}, async (stage) => {
    const write = (marker: string) =>
      writeFile(
        join(stage.home, 'claude', '.claude.json'),
        JSON.stringify({
          mcpServers: {
            counted: {
              type: 'stdio',
              ...countServer(stage.log),
              env: { FIXTURE_LOG_PATH: stage.log, MARKER: marker },
            },
          },
        }),
      )
    await write('1')
    const threadId = await startThread(stage, null)
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_1')
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_2')
    await write('2')
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_3')
    assert.deepEqual(
      shape(
        await eventually(
          () => countedServers(stage.log),
          (all) => all[0]?.closed === true,
        ),
      ),
      [
        { called: ['echo', 'echo'], closed: true },
        { called: ['echo'], closed: false },
      ],
    )
  })
})

test('MCP-024：没人用的连接空闲超时后关掉，之后的回合重新连', { timeout: 90_000 }, async () => {
  // 0.02 分钟 = 1.2 秒
  await withStage({ CHA_CLAUDE_MCP_IDLE_MINUTES: '0.02' }, async (stage) => {
    const threadId = await startThread(stage, { counted: countServer(stage.log) })
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_1')
    await eventually(
      () => countedServers(stage.log),
      (all) => all.length === 1 && all[0]?.closed === true,
    )
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_2')
    assert.deepEqual(shape(await countedServers(stage.log)), [
      { called: ['echo'], closed: true },
      { called: ['echo'], closed: false },
    ])
  })
})

test('MCP-024：设成 0 不复用，每个回合起一份、回合结束就关（和以前一样）', {
  timeout: 90_000,
}, async () => {
  await withStage({ CHA_CLAUDE_MCP_IDLE_MINUTES: '0' }, async (stage) => {
    const threadId = await startThread(stage, { counted: countServer(stage.log) })
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_1')
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_2')
    assert.deepEqual(
      shape(
        await eventually(
          () => countedServers(stage.log),
          (all) => all[1]?.closed === true,
        ),
      ),
      [
        { called: ['echo'], closed: true },
        { called: ['echo'], closed: true },
      ],
    )
  })
})

test('MCP-024：留着的服务进程中途退出了，下一个回合照常重新连上', { timeout: 90_000 }, async () => {
  await withStage({}, async (stage) => {
    const threadId = await startThread(stage, { counted: countServer(stage.log) })
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_1')
    const [first] = await countedServers(stage.log)
    assert.ok(first)
    process.kill(first.pid, 'SIGTERM')
    await eventually(
      () => countedServers(stage.log),
      (all) => all[0]?.closed === true,
    )
    await callTool(stage, threadId, 'mcp__counted__echo', 'toolu_2')
    assert.deepEqual(shape(await countedServers(stage.log)), [
      { called: ['echo'], closed: true },
      { called: ['echo'], closed: false },
    ])
  })
})

// 征询服务：工具 ask_form 被调用时向客户端发一张表，等到答复写进工具结果
function formServer(log: string) {
  return {
    command: process.execPath,
    args: [resolve('packages/claude/test/fixtures/mcp-elicit-server.mjs')],
    env: {
      FIXTURE_LOG_PATH: log,
      FIXTURE_ELICITATION: JSON.stringify({
        mode: 'form',
        message: '填一下',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
      }),
    },
  }
}

async function wire(log: string): Promise<Array<{ from: string; message: any; pid: number }>> {
  return (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const toolCallPids = async (log: string) =>
  (await wire(log))
    .filter((entry) => entry.from === 'client' && entry.message.method === 'tools/call')
    .map((entry) => entry.pid)

test('MCP-024：复用的连接上，服务发来的征询带的是当前回合的回合号', {
  timeout: 90_000,
}, async () => {
  await withStage({}, async (stage) => {
    const threadId = await startThread(stage, { forms: formServer(stage.log) })
    const asked: Array<string | null> = []
    stage.client.onServerRequest = async (method, params) => {
      assert.equal(method, 'mcpServer/elicitation/request')
      asked.push(params.turnId)
      return { action: 'accept', content: { name: '甲' }, _meta: null }
    }
    const first = await callTool(stage, threadId, 'mcp__forms__ask_form', 'toolu_1')
    const second = await callTool(stage, threadId, 'mcp__forms__ask_form', 'toolu_2')
    assert.deepEqual(asked, [first, second])
    const pids = await toolCallPids(stage.log)
    assert.equal(pids.length, 2)
    assert.equal(pids[0], pids[1], '第二个回合应当接着用同一份服务')
  })
})

test('MCP-024：回合在征询挂着时被打断，那条连接关掉、不回池；下一个回合重新连，征询照常', {
  timeout: 90_000,
}, async () => {
  await withStage({}, async (stage) => {
    const threadId = await startThread(stage, { forms: formServer(stage.log) })
    const requested = deferred()
    const late = deferred()
    let answering: 'hold' | 'accept' = 'hold'
    stage.client.onServerRequest = async () => {
      if (answering === 'hold') {
        requested.resolve()
        await late.promise
      }
      return { action: 'accept', content: { name: '乙' }, _meta: null }
    }
    stage.model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_held', name: 'mcp__forms__ask_form', input: {} },
    ])
    const { turn } = await stage.client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '表单还没填就打断' }],
    })
    await requested.promise
    await stage.client.request('turn/interrupt', { threadId, turnId: turn.id })
    assert.equal((await stage.client.completed(turn.id)).status, 'interrupted')
    stage.model.assertConsumed()
    // 挂着的征询随连接作废：服务看到连接关了，那次征询没有答复
    const closed = await eventually(
      () => wire(stage.log),
      (entries) => entries.some((entry) => entry.from === 'fixture'),
    )
    assert.equal(closed.find((entry) => entry.from === 'fixture')?.message.unanswered.length, 1)
    // 迟到的答复到不了任何服务
    late.resolve()
    answering = 'accept'
    await callTool(stage, threadId, 'mcp__forms__ask_form', 'toolu_after')
    const pids = await toolCallPids(stage.log)
    assert.equal(pids.length, 2)
    assert.notEqual(pids[0], pids[1], '被打断的那条连接不该再被用')
    const answers = (await wire(stage.log)).filter(
      (entry) => entry.from === 'client' && entry.message.result?.action === 'accept',
    )
    assert.deepEqual(
      answers.map((entry) => [entry.pid, entry.message.result.content]),
      [[pids[1], { name: '乙' }]],
    )
  })
})

test('MCP-024：守护进程上的客户端全都断开后，留着的连接（stdio 服务的子进程）马上关掉，不等空闲超时', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-reuse-detach-'))
  const cwd = join(home, 'project')
  const log = join(home, 'counted.jsonl')
  await mkdir(cwd)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start())
  try {
    const client = await daemon.connect('first', {
      optOutNotificationMethods: [STARTUP],
    })
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { mcp_servers: { counted: countServer(log) } },
    })
    model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__counted__echo', input: {} },
    ])
    model.enqueue(() => [{ type: 'text', text: 'DONE' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '调一次 echo' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    assert.deepEqual(shape(await countedServers(log)), [{ called: ['echo'], closed: false }])
    await client.disconnect()
    assert.deepEqual(
      shape(
        await eventually(
          () => countedServers(log),
          (all) => all[0]?.closed === true,
        ),
      ),
      [{ called: ['echo'], closed: true }],
    )
  } finally {
    await daemon.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
