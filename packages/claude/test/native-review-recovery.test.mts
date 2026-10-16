import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('REVIEW-005：真实 Read 后崩溃恢复审查退出标记，二次重启不重放且退出 ID 不变', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-review-recovery-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  let cliPID: number | undefined
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    const file = join(home, 'review-target.txt')
    const marker = 'REVIEW_REAL_READ_BEFORE_CRASH'
    await writeFile(file, marker, { mode: 0o600 })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'review_read_before_crash',
        name: 'Read',
        input: { file_path: file },
      },
    ])
    model.enqueue(async (request) => {
      assert.match(JSON.stringify(request.messages), new RegExp(marker))
      entered()
      await gate
      return [{ type: 'text', text: 'LATE_REVIEW_MUST_NOT_BECOME_CONCLUSION' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'read-only',
    })
    const { turn } = await client.request('review/start', {
      threadId: thread.id,
      target: { type: 'custom', instructions: 'Read review-target.txt and review it.' },
    })
    await ready
    const readEvent = await client.notification(
      'item/completed',
      (params) =>
        params.turnId === turn.id &&
        params.item.type === 'mcpToolCall' &&
        params.item.arguments?.file_path === file,
    )
    assert.equal(readEvent.item.status, 'completed')
    const before = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const beforeTurn = before.thread.turns[0]
    assert.equal(beforeTurn.status, 'inProgress')
    assert.equal(beforeTurn.items.filter((item: any) => item.type === 'exitedReviewMode').length, 0)
    const diagnostics = (await readFile(join(home, 'adapter', 'debug.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    cliPID = diagnostics.find(
      (entry) => entry.event === 'native.process.started' && entry.turnId === turn.id,
    )?.childPid
    assert.ok(cliPID, '崩溃必须命中该回合的真实 CLI')
    const adapterPID = client.process.pid
    client.crash()
    // 同时终止该回合 CLI，模拟宿主进程树丢失，不给迟到响应写入历史的机会。
    try {
      process.kill(cliPID, 'SIGKILL')
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
    }
    await client.close()
    cliPID = undefined
    release()
    let recoveredItems: unknown[] | undefined
    let exitId: string | undefined
    for (let restart = 1; restart <= 2; restart++) {
      client = await ProtocolClient.start(home, url)
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      assert.equal(history.thread.turns.length, 1)
      const recovered = history.thread.turns[0]
      assert.equal(recovered.id, turn.id)
      assert.equal(recovered.status, 'interrupted')
      const exits = recovered.items.filter((item: any) => item.type === 'exitedReviewMode')
      assert.equal(exits.length, 1, '恢复必须补齐且只补一条审查退出记录')
      assert.match(exits[0].review, /中断.*未完成/)
      assert.doesNotMatch(exits[0].review, /LATE_REVIEW|no actionable|没有问题/)
      assert.deepEqual(
        recovered.items.filter((item: any) => item.type !== 'exitedReviewMode'),
        beforeTurn.items,
        '恢复不能修改已确认的 Read 结果或补造其他输出',
      )
      if (restart === 1) {
        exitId = exits[0].id
        recoveredItems = recovered.items
      } else {
        assert.equal(exits[0].id, exitId)
        assert.deepEqual(recovered.items, recoveredItems)
      }
      assert.equal(model.requests.length, 2, '恢复及再次读取历史不能调用模型或重放 Read')
      assert.equal(await readFile(file, 'utf8'), marker)
      await client.close()
    }
    model.assertConsumed()
    await saveArtifact('review-recovery', {
      threadId: thread.id,
      turnId: turn.id,
      adapterPID,
      signal: 'SIGKILL',
      status: 'interrupted',
      exitId,
      restartCount: 2,
      modelCalls: model.requests.length,
      readResultPreserved: true,
    })
  } finally {
    release()
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
