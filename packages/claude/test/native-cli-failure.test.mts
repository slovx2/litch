import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

for (const failure of ['frozen', 'crashed'] as const) {
  test('FAILURE-003：真实 CLI ' + failure + ' 后审批失效、无重放且能恢复会话', {
    timeout: 30_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-cli-failure-'))
    const target = join(home, 'must-not-write.txt')
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    let requested!: () => void
    let release!: () => void
    const asking = new Promise<void>((resolve) => {
      requested = resolve
    })
    const answer = new Promise<void>((resolve) => {
      release = resolve
    })
    let cliPID: number | undefined
    try {
      client.onServerRequest = async (method) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        requested()
        await answer
        return { decision: 'accept' }
      }
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_pending_write',
          name: 'Write',
          input: { file_path: target, content: '迟到授权不能执行' },
        },
      ])
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '等待审批再写入' }],
      })
      await asking
      // 使用运行时的真实 spawn 诊断定位子进程，避免沙箱禁止系统级 ps。
      const children = (await readFile(join(home, 'adapter', 'debug.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter(
          (entry) =>
            entry.event === 'native.process.started' &&
            entry.turnId === turn.id &&
            entry.pid === client.process.pid,
        )
      assert.equal(children.length, 1, '本场景应只有一个真实 CLI 子进程')
      cliPID = children[0].childPid
      assert.ok(cliPID && Number.isInteger(cliPID))
      process.kill(cliPID, failure === 'frozen' ? 'SIGSTOP' : 'SIGKILL')
      const started = Date.now()
      if (failure === 'frozen')
        await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, failure === 'frozen' ? 'interrupted' : 'failed')
      assert.ok(Date.now() - started < 8_000, '中断必须有界，不能等到客户端 RPC 超时')
      assert.throws(() => process.kill(cliPID!, 0), { code: 'ESRCH' }, 'CLI 必须真的退出')
      const resolved = client.trace.filter((x) => x.method === 'serverRequest/resolved')
      assert.equal(resolved.length, 1)
      assert.ok(
        client.trace.indexOf(resolved[0]) <
          client.trace.findIndex(
            (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
          ),
        '旧审批必须先结束，再发布回合终态',
      )
      release()
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
      await assert.rejects(access(target))
      assert.equal(model.requests.length, 1, '崩溃或取消后不能自动重新请求模型')

      model.enqueue((request) => {
        const history = JSON.stringify(request.messages)
        assert.match(history, /等待审批再写入/)
        assert.match(history, /toolu_pending_write/)
        assert.match(history, /明确继续，仅回复恢复成功/)
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter(
            (block: any) =>
              block.type === 'tool_result' && block.tool_use_id === 'toolu_pending_write',
          )
        assert.equal(results.length, 1, '恢复时原生上下文必须对未执行工具补齐取消结果')
        assert.equal(results[0].is_error, true)
        return [{ type: 'text', text: 'RECOVERED_AFTER_CLI_FAILURE' }]
      })
      const next = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '明确继续，仅回复恢复成功' }],
      })
      const nextCompleted = await client.completed(next.turn.id)
      assert.equal(
        nextCompleted.status,
        'completed',
        JSON.stringify(nextCompleted) + '\n' + client.stderr.slice(-4000),
      )
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      assert.deepEqual(
        history.thread.turns.map((item: any) => item.status),
        [completed.status, 'completed'],
      )
      assert.ok(
        history.thread.turns.every((item: any) =>
          item.items.every((entry: any) => entry.status !== 'inProgress'),
        ),
      )
      await assert.rejects(access(target))
      assert.equal(model.requests.length, 2)
      model.assertConsumed()
    } finally {
      release()
      if (cliPID) {
        try {
          process.kill(cliPID, 'SIGCONT')
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
        }
      }
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
