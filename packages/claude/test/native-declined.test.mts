import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { declaring, declineWithNoteView } from './fixtures/extension-wire.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 用户在审批里拒绝的调用（真实 CLI）：条目照上游 app-server 记成“已拒绝”，不是执行失败。
// 命令没有执行，所以没有输出、退出码和时长；给模型看的那句拒绝的话（带说明时连同说明）只进工具结果。
// 实时的 item/completed 和 thread/read 读回的是同一个样子。

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const toolResult = (request: ModelRequest, id: string): any =>
  (request.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)

// 一个回合：模型调用一个要问的工具，用户按 reply 作答。返回实时收到的条目、读回的条目和模型看到的工具结果。
async function declinedTurn(
  client: ProtocolClient,
  model: MockLLM,
  threadId: string,
  call: { id: string; name: string; input: Record<string, unknown> },
  reply: unknown,
) {
  let answered = 0
  let asked: any
  client.onServerRequest = async (_method, params) => {
    answered++
    asked = params
    return reply
  }
  const stops = (reply as { decision?: unknown }).decision === 'cancel'
  let result: any
  model.enqueue(() => [{ type: 'tool_use', ...call }])
  // 选了“拒绝并停下”时回合就此结束，模型不再被请求。
  if (!stops)
    model.enqueue((request) => {
      result = toolResult(request, call.id)
      return [{ type: 'text', text: '知道了' }]
    })
  const { turn } = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `执行 ${call.id}` }],
  })
  const done = await client.completed(turn.id)
  model.assertConsumed()
  assert.equal(answered, 1)
  const ofTurn = (method: string) =>
    client.trace
      .filter((x) => x.method === method && x.params.turnId === turn.id)
      .map((x) => x.params)
  const started = ofTurn('item/started').map((params) => params.item)
  const tool = started.find((item: any) => item.type !== 'agentMessage')
  assert.ok(tool, '被拒绝的调用也有条目')
  const completed = ofTurn('item/completed')
    .map((params) => params.item)
    .filter((item: any) => item.id === tool.id)
  // 收尾只发一次
  assert.equal(completed.length, 1, JSON.stringify(completed))
  const outputs = ofTurn('item/commandExecution/outputDelta').filter((p) => p.itemId === tool.id)
  const read = await client.request('thread/read', { threadId, includeTurns: true })
  const stored = read.thread.turns
    .find((entry: any) => entry.id === turn.id)
    .items.find((item: any) => item.id === tool.id)
  return { status: done.status, live: completed[0], stored, outputs, result, asked }
}

test('DECLINE-001：拒绝的命令和文件改动是“已拒绝”，带说明的拒绝照旧把说明交给模型', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-declined-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    declaring('declineWithNote'),
  )
  client.standardView = declineWithNoteView
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':workspace',
    })
    const bash = (id: string) => ({
      id,
      name: 'Bash',
      input: { command: 'printf ran > ran.txt', description: 'write a marker' },
    })

    const plain = await declinedTurn(client, model, thread.id, bash('toolu_plain'), {
      decision: 'decline',
    })
    assert.equal(plain.status, 'completed')
    assert.equal(plain.live.type, 'commandExecution')
    assert.equal(plain.live.status, 'declined')
    assert.equal(plain.live.exitCode, null)
    assert.equal(plain.live.aggregatedOutput, null)
    assert.equal(plain.live.durationMs, null)
    // 审批卡片上的目录就是命令要跑的目录，和条目上的一样
    assert.equal(plain.live.cwd, thread.cwd)
    assert.equal(plain.asked.cwd, plain.live.cwd)
    assert.deepEqual(plain.stored, plain.live)
    assert.deepEqual(plain.outputs, [])
    // 模型照旧收到拒绝
    assert.equal(plain.result.is_error, true)
    assert.match(JSON.stringify(plain.result.content), /denied by user/)

    const noted = await declinedTurn(client, model, thread.id, bash('toolu_noted'), {
      decision: { declineWithNote: { note: '先别动这个目录' } },
    })
    assert.equal(noted.live.status, 'declined')
    assert.equal(noted.live.aggregatedOutput, null)
    assert.deepEqual(noted.stored, noted.live)
    assert.match(
      JSON.stringify(noted.result.content),
      /The user left this note explaining why: 先别动这个目录/,
    )

    const write = await declinedTurn(
      client,
      model,
      thread.id,
      { id: 'toolu_write', name: 'Write', input: { file_path: join(home, 'w.txt'), content: 'w' } },
      { decision: 'decline' },
    )
    assert.equal(write.live.type, 'fileChange')
    assert.equal(write.live.status, 'declined')
    assert.deepEqual(write.stored, write.live)
    assert.equal(write.result.is_error, true)

    // “拒绝并停下”：回合被中断，条目同样是“已拒绝”（上游也是），不是被中断收尾成的失败。
    const stopped = await declinedTurn(client, model, thread.id, bash('toolu_cancel'), {
      decision: 'cancel',
    })
    assert.equal(stopped.status, 'interrupted')
    assert.equal(stopped.live.status, 'declined')
    assert.equal(stopped.live.exitCode, null)
    assert.equal(stopped.live.aggregatedOutput, null)
    assert.deepEqual(stopped.stored, stopped.live)

    assert.equal(await exists(join(home, 'ran.txt')), false, '被拒绝的命令都没有执行')
    assert.equal(await exists(join(home, 'w.txt')), false)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DECLINE-002：没有“已拒绝”状态的条目（Claude Code 自带的别的工具）照旧是失败，原因在错误里', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-declined-tool-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    // 完全访问的沙箱、按需审批：网络不拦，WebFetch 要问
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'on-request',
    })
    const fetched = await declinedTurn(
      client,
      model,
      thread.id,
      { id: 'toolu_fetch', name: 'WebFetch', input: { url: 'http://127.0.0.1:9/x', prompt: 'p' } },
      { decision: 'decline' },
    )
    assert.equal(fetched.live.type, 'mcpToolCall')
    assert.equal(fetched.live.status, 'failed')
    assert.match(fetched.live.error.message, /denied by user/)
    assert.deepEqual(fetched.stored, fetched.live)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
