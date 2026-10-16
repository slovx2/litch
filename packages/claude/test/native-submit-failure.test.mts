import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('SUBMIT-002：真实工具副作用后适配器崩溃，重试和重启不能重放不确定调用', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-submit-failure-'))
  const effect = join(home, 'effect.txt')
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  let cliPID: number | undefined
  let calls = 0
  try {
    let effected!: () => void
    const committed = new Promise<void>((resolve) => {
      effected = resolve
    })
    client.onTool = async (params) => {
      calls++
      assert.equal(params.callId, 'toolu_uncertain_effect')
      await appendFile(effect, 'EXECUTED_ONCE\n')
      effected()
      // 执行器已经产生实际副作用，响应尚未到达时让真实适配器进程崩溃。
      return new Promise(() => {})
    }
    const toolStep = (request: any) => {
      const tool = request.tools.find((item: any) =>
        item.name.startsWith('mcp__codex_harness_adapter__'),
      )
      assert.ok(tool, '动态工具必须真正经过 SDK 注册')
      return [{ type: 'tool_use', id: 'toolu_uncertain_effect', name: tool.name, input: {} }]
    }
    model.enqueue(toolStep)
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'append_effect',
          description: '追加一次测试记录',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    const submission = {
      threadId: thread.id,
      clientUserMessageId: 'uncertain-message',
      input: [{ type: 'text', text: '执行追加工具' }],
    }
    const { turn } = await client.request('turn/start', submission)
    await committed
    const intent = () =>
      db
        .prepare('SELECT result_json FROM tool_executions WHERE thread_id=? AND call_id=?')
        .get(thread.id, 'toolu_uncertain_effect')
    assert.equal(intent()?.result_json, null)
    const diagnostics = (await readFile(join(home, 'adapter', 'debug.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    cliPID = diagnostics.find(
      (entry) => entry.event === 'native.process.started' && entry.turnId === turn.id,
    )?.childPid
    assert.ok(cliPID)
    client.crash()
    await client.close()
    const deadline = Date.now() + 5_000
    let alive = true
    while (alive && Date.now() < deadline) {
      try {
        process.kill(cliPID!, 0)
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
        alive = false
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(alive, false, '适配器崩溃后真实 CLI 必须有界退出')
    client = await ProtocolClient.start(home, url)
    client.onTool = async () => {
      calls++
      throw new Error('不确定工具不能再次派发')
    }
    const resumed = await client.request('thread/resume', { threadId: thread.id })
    assert.equal(resumed.thread.turns.length, 1)
    const recovered = resumed.thread.turns[0]
    assert.equal(recovered.id, turn.id)
    assert.equal(recovered.status, 'interrupted')
    const item = recovered.items.find((item: any) => item.id === 'toolu_uncertain_effect')
    assert.equal(item.status, 'failed')
    assert.equal(item.success, null, '没有确认结果，不能声称副作用成功或失败')
    assert.match(JSON.stringify(item.contentItems), /结果不确定/)
    const retry = await client.request('turn/start', submission)
    assert.equal(retry.turn.id, turn.id)
    await client.raw(
      'turn/start',
      { ...submission, input: [{ type: 'text', text: '冲突内容' }] },
      -32009,
    )
    assert.equal(model.requests.length, 1, '同提交重试不得再次调用模型')
    model.enqueue(toolStep)
    model.enqueue((request) => {
      const recoveredResults = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter(
          (block: any) =>
            block.type === 'tool_result' && block.tool_use_id === 'toolu_uncertain_effect',
        )
      assert.equal(recoveredResults.length, 1, '真实 SDK 必须为未确认工具补齐唯一未知结果')
      assert.equal(recoveredResults[0].is_error, true)
      assert.match(JSON.stringify(recoveredResults[0]), /outcome is unknown/)
      return [{ type: 'text', text: '需要人工核对工具结果，未重复执行' }]
    })
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '明确继续，核对上次工具结果' }],
    })
    const completed = await client.completed(next.turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(calls, 1)
    assert.equal(await readFile(effect, 'utf8'), 'EXECUTED_ONCE\n')
    assert.equal(intent()?.result_json, null, '不能用模型输出补造执行结果')
    model.assertConsumed()
  } finally {
    db.close()
    if (cliPID) {
      try {
        process.kill(cliPID, 'SIGKILL')
      } catch {}
    }
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
