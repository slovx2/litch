import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('CONTEXT-003：真实回退事务失败不能分离原生上下文和展示历史', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-rollback-failure-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const start = async (text: string) => {
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text }],
        clientUserMessageId: text,
      })
      assert.equal(
        (await client.completed(turn.id)).status,
        'completed',
        client.stderr.slice(-2000),
      )
      return turn.id
    }
    model.enqueue(() => [{ type: 'text', text: 'KEPT_ORIGINAL_ANSWER' }])
    const kept = await start('KEPT_ORIGINAL_INPUT')
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /KEPT_ORIGINAL_ANSWER/)
      return [{ type: 'text', text: 'ROLLBACK_TARGET_ANSWER' }]
    })
    const dropped = await start('ROLLBACK_TARGET_INPUT')
    const snapshot = () => ({
      thread: db.prepare('SELECT claude_session_id FROM threads WHERE id=?').get(thread.id),
      turns: db.prepare('SELECT * FROM turns WHERE thread_id=? ORDER BY rowid').all(thread.id),
      boundaries: db.prepare('SELECT * FROM native_turn_boundaries ORDER BY rowid').all(),
      submissions: db
        .prepare('SELECT * FROM submissions WHERE thread_id=? ORDER BY rowid')
        .all(thread.id),
    })
    const before = snapshot()
    assert.equal(before.turns.length, 2)
    // 原生 fork 已实际创建后，让 SQLite 在删除展示 Turn 时失败。
    // 不是 MockRuntime，也没有预制/改写历史或 session 指针。
    db.exec(
      "CREATE TRIGGER reject_rollback BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'INJECTED_ROLLBACK_FAILURE'); END",
    )
    const failure = await client.raw(
      'thread/rollback',
      { threadId: thread.id, numTurns: 1 },
      -32000,
    )
    assert.match(failure.error.message, /INJECTED_ROLLBACK_FAILURE/)
    assert.deepEqual(snapshot(), before, '事务必须同时恢复 session 指针、Turn、边界和提交身份')
    assert.equal(model.requests.length, 2, '回退不能调用模型')
    db.exec('DROP TRIGGER reject_rollback')
    await client.close()
    client = await ProtocolClient.start(home, url)
    const resumed = await client.request('thread/resume', { threadId: thread.id })
    assert.deepEqual(
      resumed.thread.turns.map((turn: any) => turn.id),
      [kept, dropped],
    )
    model.enqueue((request) => {
      const text = JSON.stringify(request.messages)
      assert.match(text, /KEPT_ORIGINAL_ANSWER/)
      assert.match(text, /ROLLBACK_TARGET_ANSWER/, '失败后恢复必须继续原 session')
      return [{ type: 'text', text: 'AFTER_FAILED_ROLLBACK_ANSWER' }]
    })
    await start('AFTER_FAILED_ROLLBACK_INPUT')
    const rollback = await client.request('thread/rollback', { threadId: thread.id, numTurns: 2 })
    assert.deepEqual(
      rollback.thread.turns.map((turn: any) => turn.id),
      [kept],
    )
    model.enqueue((request) => {
      const text = JSON.stringify(request.messages)
      assert.match(text, /KEPT_ORIGINAL_ANSWER/)
      assert.doesNotMatch(text, /ROLLBACK_TARGET_|AFTER_FAILED_ROLLBACK_/)
      return [{ type: 'text', text: 'CONTEXT_AND_HISTORY_CONSISTENT' }]
    })
    await start('CONTINUE_AFTER_SUCCESSFUL_ROLLBACK')
    model.assertConsumed()
  } finally {
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
