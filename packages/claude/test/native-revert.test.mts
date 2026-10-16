import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

for (const historyMode of ['paginated', 'legacy']) {
  test(`CONTEXT-008：${historyMode}真实定点回退、事务失败、活动冲突、上下文及重启持久`, {
    timeout: 120_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-revert-'))
    const model = new MockLLM()
    const url = await model.start()
    let client = await ProtocolClient.start(home, url)
    const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
    const entered = signal()
    const release = signal()
    const file = join(home, 'retained-file.txt')
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        historyMode,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      const other = (await client.request('thread/start', { cwd: home })).thread
      const start = async (text: string) => {
        const { turn } = await client.request('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text }],
          clientUserMessageId: text,
        })
        assert.equal((await client.completed(turn.id)).status, 'completed')
        return turn.id as string
      }
      const read = async () =>
        (
          await client.request('thread/read', {
            threadId: thread.id,
            includeTurns: true,
          })
        ).thread
      model.enqueue(() => [{ type: 'text', text: 'REVERT_KEEP_ANSWER' }])
      const first = await start('REVERT_KEEP_INPUT')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_revert_write',
          name: 'Write',
          input: { file_path: file, content: 'FILES_MUST_REMAIN' },
        },
      ])
      model.enqueue(() => [{ type: 'text', text: 'REVERT_DROP_TOOL_ANSWER' }])
      const second = await start('REVERT_DROP_TOOL_INPUT')
      model.enqueue(async () => {
        entered.resolve()
        await release.promise
        return [{ type: 'text', text: 'REVERT_DROP_LAST_ANSWER' }]
      })
      const third = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'REVERT_DROP_LAST_INPUT' }],
      })
      await entered.promise
      await client.raw('thread/revert', { threadId: thread.id, beforeTurnId: second }, -32009)
      release.resolve()
      assert.equal((await client.completed(third.turn.id)).status, 'completed')
      assert.equal(await readFile(file, 'utf8'), 'FILES_MUST_REMAIN')
      const original = await read()
      const oldPage = await client.request('thread/turns/list', {
        threadId: thread.id,
        itemsView: 'full',
        limit: 1,
      })
      await client.raw('thread/revert', { threadId: other.id, beforeTurnId: second }, -32602)
      await client.raw('thread/revert', { threadId: thread.id, beforeTurnId: 'missing' }, -32602)
      const snapshot = () => ({
        thread: db.prepare('SELECT * FROM threads WHERE id=?').get(thread.id),
        turns: db.prepare('SELECT * FROM turns WHERE thread_id=? ORDER BY rowid').all(thread.id),
        boundaries: db.prepare('SELECT * FROM native_turn_boundaries ORDER BY rowid').all(),
        submissions: db.prepare('SELECT * FROM submissions ORDER BY rowid').all(),
      })
      const before = snapshot()
      db.exec(
        "CREATE TRIGGER reject_revert BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'INJECTED_REVERT_FAILURE'); END",
      )
      const failure = await client.raw(
        'thread/revert',
        {
          threadId: thread.id,
          beforeTurnId: second,
        },
        -32000,
      )
      assert.match(failure.error.message, /INJECTED_REVERT_FAILURE/)
      assert.deepEqual(snapshot(), before, '真实 fork 后数据库失败必须保留原 session 与全部历史')
      assert.deepEqual(await read(), original)
      assert.equal(client.trace.filter((entry) => entry.method === 'thread/reverted').length, 0)
      db.exec('DROP TRIGGER reject_revert')
      assert.equal(model.requests.length, 4, '回退及失败不能请求模型')

      const result = await client.request('thread/revert', {
        threadId: thread.id,
        beforeTurnId: second,
      })
      assert.deepEqual(result.thread.turns, [])
      assert.equal(result.thread.historyMode, historyMode)
      assert.ok(result.turnsBackwardsCursor)
      assert.ok(result.itemsBackwardsCursor)
      await client.notification('thread/reverted', (params) => params.threadId === thread.id)
      assert.equal(client.trace.filter((entry) => entry.method === 'thread/reverted').length, 1)
      const kept = original.turns[0]
      const retainedTurns = await client.request('thread/turns/list', {
        threadId: thread.id,
        cursor: result.turnsBackwardsCursor,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      assert.deepEqual(retainedTurns.data, [kept], '回退游标必须包含保留的最后回合')
      const retainedItems = await client.request('thread/items/list', {
        threadId: thread.id,
        cursor: result.itemsBackwardsCursor,
        sortDirection: 'desc',
      })
      assert.deepEqual(
        retainedItems.data,
        [...kept.items].reverse().map((item: any) => ({ turnId: first, item })),
      )
      await client.raw(
        'thread/turns/list',
        {
          threadId: thread.id,
          cursor: oldPage.backwardsCursor,
        },
        -32602,
      )
      await client.raw('thread/revert', { threadId: thread.id, beforeTurnId: second }, -32602)
      const timeline = await client.request('thread/timeline/list', { threadId: thread.id })
      assert.ok(timeline.data.every((entry: any) => entry.turnId === first))
      assert.equal(await readFile(file, 'utf8'), 'FILES_MUST_REMAIN')
      await client.close()
      client = await ProtocolClient.start(home, url)
      assert.deepEqual((await read()).turns, [kept])
      await client.request('thread/resume', { threadId: thread.id, excludeTurns: true })
      await client.raw(
        'turn/start',
        {
          threadId: thread.id,
          clientUserMessageId: 'REVERT_DROP_TOOL_INPUT',
          input: [{ type: 'text', text: 'REVERT_DROP_TOOL_INPUT' }],
        },
        -32009,
      )
      model.enqueue((request) => {
        const history = JSON.stringify(request.messages)
        assert.match(history, /REVERT_KEEP_ANSWER/)
        assert.doesNotMatch(history, /REVERT_DROP_|FILES_MUST_REMAIN/)
        return [{ type: 'text', text: 'REVERT_CONTINUE_OK' }]
      })
      await start('REVERT_CONTINUE_INPUT')
      // 分叉会重写 UUID；旧入口再次回退也必须使用已提交的新边界。
      await client.request('thread/rollback', { threadId: thread.id, numTurns: 1 })
      assert.deepEqual((await read()).turns, [kept])
      const branch = (await client.request('thread/fork', { threadId: thread.id })).thread
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), /REVERT_KEEP_ANSWER/)
        assert.doesNotMatch(JSON.stringify(request.messages), /REVERT_DROP_|REVERT_CONTINUE_/)
        return [{ type: 'text', text: 'FORK_DROP_ANSWER' }]
      })
      const branchTurn = await client.request('turn/start', {
        threadId: branch.id,
        input: [{ type: 'text', text: 'FORK_DROP_INPUT' }],
      })
      assert.equal((await client.completed(branchTurn.turn.id)).status, 'completed')
      await client.request('thread/revert', {
        threadId: branch.id,
        beforeTurnId: branchTurn.turn.id,
      })
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), /REVERT_KEEP_ANSWER/)
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /FORK_DROP_|REVERT_DROP_|REVERT_CONTINUE_/,
        )
        return [{ type: 'text', text: 'FORK_CONTINUE_OK' }]
      })
      const branchNext = await client.request('turn/start', {
        threadId: branch.id,
        input: [{ type: 'text', text: 'FORK_CONTINUE_INPUT' }],
      })
      assert.equal((await client.completed(branchNext.turn.id)).status, 'completed')
      assert.deepEqual((await read()).turns, [kept], '分支回退不能改变父会话')
      const empty = await client.request('thread/revert', {
        threadId: thread.id,
        beforeTurnId: first,
      })
      assert.deepEqual(empty.thread.turns, [])
      assert.equal(empty.turnsBackwardsCursor, null)
      assert.equal(empty.itemsBackwardsCursor, null)
      assert.deepEqual((await read()).turns, [])
      await client.close()
      client = await ProtocolClient.start(home, url)
      model.enqueue((request) => {
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /REVERT_KEEP_|REVERT_DROP_|REVERT_CONTINUE_/,
        )
        return [{ type: 'text', text: 'EMPTY_HISTORY_CONTINUES' }]
      })
      await start('NEW_EMPTY_HISTORY_INPUT')
      assert.equal(await readFile(file, 'utf8'), 'FILES_MUST_REMAIN')
      assert.equal(model.requests.length, 8)
      model.assertConsumed()
    } finally {
      release.resolve()
      db.close()
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
