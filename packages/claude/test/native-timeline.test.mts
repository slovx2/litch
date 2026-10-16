import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function timeline(client: ProtocolClient, threadId: string, limit = 1000) {
  return client.request('thread/timeline/list', { threadId, limit })
}

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

test('HISTORY-007：真实回合时间线、活动边界、分页追加、会话隔离及重启无模型读取', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-timeline-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const release = signal()
  const entered = signal()
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const other = (await client.request('thread/start', { cwd: home })).thread
    assert.deepEqual(await timeline(client, thread.id), {
      data: [],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    })
    model.enqueue(() => [{ type: 'text', text: 'FIRST_TIMELINE_ANSWER' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'FIRST_TIMELINE_INPUT' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const firstHistory = await timeline(client, thread.id)
    const firstPage = await timeline(client, thread.id, 2)
    assert.ok(firstPage.nextCursor)
    // 新回合在读取旧页期间追加，旧游标仍指向原条目而非偏移量。
    model.enqueue(async () => {
      entered.resolve()
      await release.promise
      return [{ type: 'text', text: 'SECOND_TIMELINE_ANSWER' }]
    })
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SECOND_TIMELINE_INPUT' }],
    })
    await entered.promise
    const active = await timeline(client, thread.id)
    const activeEntries = active.data.filter((entry: any) => entry.turnId === second.turn.id)
    assert.equal(activeEntries[0].type, 'turnStarted')
    assert.ok(activeEntries.some((entry: any) => entry.type === 'item'))
    assert.ok(!activeEntries.some((entry: any) => entry.type === 'turnCompleted'))
    const older = await client.request('thread/timeline/list', {
      threadId: thread.id,
      cursor: firstPage.nextCursor,
      limit: 1000,
    })
    assert.deepEqual([...older.data, ...firstPage.data], firstHistory.data)
    await assert.rejects(
      client.request('thread/timeline/list', {
        threadId: other.id,
        cursor: firstPage.nextCursor,
      }),
      /游标/,
    )
    const turnsPage = await client.request('thread/turns/list', { threadId: thread.id, limit: 1 })
    await assert.rejects(
      client.request('thread/timeline/list', {
        threadId: thread.id,
        cursor: turnsPage.nextCursor,
      }),
      /游标/,
    )
    release.resolve()
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    const full = await timeline(client, thread.id)
    const history = (
      await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
    ).thread.turns
    const expectedItems = history.flatMap((turn: any) => turn.items)
    assert.deepEqual(
      full.data.filter((entry: any) => entry.type === 'item').map((entry: any) => entry.item),
      expectedItems,
    )
    assert.deepEqual(
      full.data.map((entry: any) => entry.position),
      full.data.map((_: any, index: number) => index),
    )
    for (const turn of history) {
      const entries = full.data.filter((entry: any) => entry.turnId === turn.id)
      assert.equal(entries[0].type, 'turnStarted')
      assert.equal(entries.at(-1).type, 'turnCompleted')
      for (const entry of entries.filter((entry: any) => entry.type !== 'item')) {
        assert.equal(entry.turn_id, entry.turnId)
        assert.equal(entry.started_at, turn.startedAt)
        assert.equal(entry.startedAt, turn.startedAt)
      }
      const terminal = entries.at(-1)
      assert.equal(terminal.status, turn.status)
      assert.equal(terminal.completed_at, terminal.completedAt)
      assert.equal(terminal.completedAt, turn.completedAt)
      assert.equal(terminal.duration_ms, terminal.durationMs)
      assert.equal(terminal.durationMs, turn.durationMs)
      assert.equal(terminal.error, null)
    }
    for (const limit of [1, 2, 3]) {
      let cursor: string | null = null
      let entries: any[] = []
      for (let page = 0; page < 30; page++) {
        const result = await client.request('thread/timeline/list', {
          threadId: thread.id,
          limit,
          cursor,
        })
        assert.equal(result.activeRealtimeSessionAtPageStart, null)
        assert.ok(result.data.length > 0)
        entries = [...result.data, ...entries]
        cursor = result.nextCursor
        if (cursor === null) break
      }
      assert.equal(cursor, null)
      assert.deepEqual(entries, full.data)
    }
    assert.deepEqual((await timeline(client, other.id)).data, [])
    await assert.rejects(timeline(client, 'missing-thread'), /未知会话/)
    await assert.rejects(timeline(client, thread.id, 0), /limit/)
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await timeline(client, thread.id), full)
    assert.deepEqual(
      await client.request('thread/timeline/list', {
        threadId: thread.id,
        cursor: firstPage.nextCursor,
        limit: 1000,
      }),
      older,
    )
    assert.equal(model.requests.length, 2, '所有读取、分页和恢复只使用持久化历史')
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
