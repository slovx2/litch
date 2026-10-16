import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function writeTool(id: string, path: string) {
  return { type: 'tool_use', id, name: 'Write', input: { file_path: path, content: id } }
}

function approvalReply() {
  let resolve!: (reply: { decision: string }) => void
  const promise = new Promise<{ decision: string }>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function completedWrite(request: ModelRequest, id: string) {
  const block = request.messages
    .flatMap((message: { content: unknown }) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (value: { type: string; tool_use_id: string }) =>
        value.type === 'tool_result' && value.tool_use_id === id,
    )
  assert.ok(block, '原生工具结果必须回到所属模型')
  assert.notEqual(block.is_error, true)
  return [{ type: 'text', text: 'APPROVAL_LIFECYCLE_DONE' }]
}

async function start(client: ProtocolClient, threadId: string, text: string) {
  return client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
  })
}

async function newThread(client: ProtocolClient, home: string) {
  return client.request('thread/start', {
    cwd: home,
    sandbox: 'danger-full-access',
    approvalPolicy: 'on-request',
  })
}

test('APPROVAL-002：真实回合中断仅取消本会话，迟到允许无副作用', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-approval-interrupt-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const rejected = join(home, 'interrupted.txt')
  const allowed = join(home, 'unaffected.txt')
  const oldReply = approvalReply()
  const otherReply = approvalReply()
  try {
    const first = await newThread(client, home)
    const other = await newThread(client, home)
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/fileChange/requestApproval')
      assert.ok([first.thread.id, other.thread.id].includes(params.threadId))
      return params.threadId === first.thread.id ? oldReply.promise : otherReply.promise
    }
    model.enqueue(() => [writeTool('toolu_interrupted', rejected)])
    const firstTurn = await start(client, first.thread.id, '等待后中断')
    const pending = await client.notification(
      'item/fileChange/requestApproval',
      (params) => params.threadId === first.thread.id,
    )
    model.enqueue(() => [writeTool('toolu_unaffected', allowed)])
    const otherTurn = await start(client, other.thread.id, '另一个会话仍待审批')
    await client.notification(
      'item/fileChange/requestApproval',
      (params) => params.threadId === other.thread.id,
    )
    await assert.rejects(access(rejected))
    await assert.rejects(access(allowed))
    await client.request('turn/interrupt', { threadId: first.thread.id, turnId: firstTurn.turn.id })
    assert.equal((await client.completed(firstTurn.turn.id)).status, 'interrupted')
    // 真实发送原请求的迟到答案；不修改 ID、通知或 CLI 行为。
    oldReply.resolve({ decision: 'accept' })
    await oldReply.promise
    await client.request('thread/read', { threadId: first.thread.id, includeTurns: true })
    await assert.rejects(access(rejected))
    await assert.rejects(access(allowed))
    assert.equal(model.requests.length, 2, '中断与迟到答案不得续写模型')
    model.enqueue((request) => completedWrite(request, 'toolu_unaffected'))
    otherReply.resolve({ decision: 'accept' })
    assert.equal((await client.completed(otherTurn.turn.id)).status, 'completed')
    assert.equal(await readFile(allowed, 'utf8'), 'toolu_unaffected')
    await assert.rejects(access(rejected))
    const itemEnds = client.trace.filter(
      (entry) =>
        entry.method === 'item/completed' &&
        entry.params.threadId === first.thread.id &&
        entry.params.item.id === pending.itemId,
    )
    assert.equal(itemEnds.length, 1, '被取消的审批条目只能有一个终态')
    assert.equal(model.requests.length, 3)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const shutdown of ['stdin-eof', 'sigterm'] as const) {
  test(`APPROVAL-002：真实待审批 ${shutdown} 后原地恢复不执行旧工具`, {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-approval-close-'))
    const model = new MockLLM()
    const url = await model.start()
    let client = await ProtocolClient.start(home, url)
    const oldPath = join(home, 'old.txt')
    const newPath = join(home, 'new.txt')
    try {
      const { thread } = await newThread(client, home)
      client.onServerRequest = async (method) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        return new Promise<never>(() => {})
      }
      model.enqueue(() => [writeTool('toolu_old', oldPath)])
      const { turn } = await start(client, thread.id, '待审批时关闭连接')
      await client.notification('item/fileChange/requestApproval')
      await assert.rejects(access(oldPath))
      if (shutdown === 'stdin-eof') {
        const exited = once(client.process, 'close')
        client.process.stdin.end()
        const [code, signal] = await exited
        assert.equal(code, 0, '真实 stdin 断线必须正常关闭进程')
        assert.equal(signal, null)
      }
      await client.close()
      const request = client.trace.find(
        (entry) => entry.method === 'item/fileChange/requestApproval',
      )
      assert.ok(request)
      assert.equal(
        client.trace.filter(
          (entry) =>
            entry.method === 'serverRequest/resolved' &&
            entry.params.threadId === thread.id &&
            entry.params.requestId === request.id,
        ).length,
        1,
        '停止进程前必须明确且仅一次通知旧审批已失效',
      )
      assert.equal(model.requests.length, 1, '关闭待审批连接不能执行或续写模型')
      client = await ProtocolClient.start(home, url)
      const restored = await client.request('thread/resume', { threadId: thread.id })
      const oldTurn = restored.thread.turns.find((entry: { id: string }) => entry.id === turn.id)
      assert.ok(oldTurn, '恢复必须保留旧回合历史')
      assert.notEqual(oldTurn.status, 'inProgress')
      await assert.rejects(access(oldPath))
      let approvals = 0
      client.onServerRequest = async (method, params) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        assert.equal(params.threadId, thread.id)
        assert.notEqual(params.turnId, turn.id, '不能重放旧回合审批')
        approvals++
        return { decision: 'accept' }
      }
      model.enqueue(() => [writeTool('toolu_new', newPath)])
      model.enqueue((request) => completedWrite(request, 'toolu_new'))
      const next = await start(client, thread.id, '显式新回合执行新工具')
      assert.equal((await client.completed(next.turn.id)).status, 'completed')
      assert.equal(approvals, 1)
      assert.equal(await readFile(newPath, 'utf8'), 'toolu_new')
      await assert.rejects(access(oldPath))
      assert.equal(model.requests.length, 3, '旧工具不能在恢复后重放')
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
