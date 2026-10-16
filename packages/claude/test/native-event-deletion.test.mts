import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('EVENTS-009：真实推理增量与历史一致，删除通知覆盖已加载及未加载会话', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-event-deletion-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const deleted: string[] = []
  try {
    for (const state of ['loaded', 'unsubscribed', 'restarted']) {
      const { thread } = await client.request('thread/start', { cwd: home })
      model.enqueue(() => [
        { type: 'thinking', thinking: 'MOCK_REASONING_A', signature: 'mock-signature' },
        { type: 'thinking', thinking: '_B', signature: 'mock-signature' },
        { type: 'text', text: 'MOCK_FINAL' },
      ])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '校验原生推理流与删除' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const events = client.trace.filter((event) => event.params?.turnId === turn.id)
      const deltas = events.filter((event) => event.method === 'item/reasoning/summaryTextDelta')
      assert.equal(deltas.length, 2)
      assert.equal(deltas.map((event) => event.params.delta).join(''), 'MOCK_REASONING_A_B')
      const itemId = deltas[0].params.itemId
      assert.ok(
        deltas.every((event) => event.params.itemId === itemId && event.params.summaryIndex === 0),
      )
      const starts = events.filter(
        (event) => event.method === 'item/started' && event.params.item.id === itemId,
      )
      const ends = events.filter(
        (event) => event.method === 'item/completed' && event.params.item.id === itemId,
      )
      assert.equal(starts.length, 1)
      assert.equal(ends.length, 1)
      assert.ok(events.indexOf(starts[0]) < events.indexOf(deltas[0]))
      assert.ok(events.indexOf(ends[0]) > events.indexOf(deltas.at(-1)))
      assert.deepEqual(ends[0].params.item.summary, ['MOCK_REASONING_A_B'])
      assert.deepEqual(ends[0].params.item.content, [])
      assert.equal(events.filter((event) => event.method === 'item/reasoning/textDelta').length, 0)
      const parts = events.filter((event) => event.method === 'item/reasoning/summaryPartAdded')
      assert.equal(parts.length, 1)
      assert.ok(events.indexOf(parts[0]) < events.indexOf(deltas[0]))
      const before = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      assert.deepEqual(
        before.thread.turns[0].items.find((item: any) => item.id === itemId),
        ends[0].params.item,
      )
      if (state === 'unsubscribed') {
        await client.request('thread/unsubscribe', { threadId: thread.id })
      } else if (state === 'restarted') {
        await client.close()
        client = await ProtocolClient.start(home, url)
        const restored = await client.request('thread/read', {
          threadId: thread.id,
          includeTurns: true,
        })
        assert.deepEqual(restored.thread.turns, before.thread.turns)
      }
      const checkpoint = client.trace.length
      await client.request('thread/delete', { threadId: thread.id })
      const list = await client.request('thread/list', {})
      assert.equal(
        list.data.some((entry: any) => entry.id === thread.id),
        false,
      )
      const notifications = client.trace
        .slice(checkpoint)
        .filter((event) => event.direction !== 'client' && event.params?.threadId === thread.id)
      assert.equal(notifications.filter((event) => event.method === 'thread/deleted').length, 1)
      assert.equal(
        notifications.filter((event) => event.method === 'thread/closed').length,
        state === 'loaded' ? 1 : 0,
      )
      await client.raw('thread/read', { threadId: thread.id, includeTurns: true }, -32602)
      const failedCheckpoint = client.trace.length
      await client.raw('thread/delete', { threadId: thread.id }, -32602)
      assert.equal(
        client.trace.slice(failedCheckpoint).some((event) => event.method === 'thread/deleted'),
        false,
      )
      deleted.push(thread.id)
    }
    await client.close()
    client = await ProtocolClient.start(home, url)
    for (const threadId of deleted)
      await client.raw('thread/read', { threadId, includeTurns: true }, -32602)
    assert.equal(model.requests.length, 3, '查询、删除及重启不能重放模型')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
