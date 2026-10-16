import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('EVENTS-002：流式事件与历史一致，重启和归档后累计用量不丢失', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-events-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    for (let index = 0; index < 3; index++) {
      if (index === 1) {
        await client.close()
        client = await ProtocolClient.start(home, url)
        await client.request('thread/resume', { threadId: thread.id })
      }
      if (index === 2) {
        await client.request('thread/archive', { threadId: thread.id })
        await client.request('thread/unarchive', { threadId: thread.id })
        await client.request('thread/resume', { threadId: thread.id })
      }
      if (index) {
        await client.notification(
          'thread/tokenUsage/updated',
          (params) =>
            params.threadId === thread.id && params.tokenUsage.total.totalTokens === 120 * index,
        )
      }
      assert.equal(llm.requests.length, index, '恢复及归档不能请求模型')
      llm.enqueue((request) => {
        if (index) assert.match(JSON.stringify(request.messages), /EVENT_INPUT_0/)
        return [
          { type: 'text', text: 'EVENT_FIRST_' + index },
          { type: 'text', text: '_LAST' },
        ]
      })
      const start = client.trace.length
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        clientUserMessageId: 'events-' + index,
        input: [{ type: 'text', text: 'EVENT_INPUT_' + index }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const events = client.trace
        .slice(start)
        .filter(
          (message) =>
            message.method &&
            message.direction !== 'client' &&
            message.params.threadId === thread.id,
        )
      const methods = events.map((message) => message.method)
      assert.equal(methods.filter((method) => method === 'turn/started').length, 1)
      assert.equal(methods.filter((method) => method === 'turn/completed').length, 1)
      const first = methods.indexOf('turn/started')
      const last = methods.indexOf('turn/completed')
      const active = events.findIndex(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'active',
      )
      const idle = events.findIndex(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'idle',
      )
      assert.ok(active >= 0 && idle > active && idle <= last)
      const starts = new Set<string>()
      const ends = new Set<string>()
      let streamed = ''
      for (const [position, event] of events.entries()) {
        if (event.method.startsWith('item/')) assert.ok(position > first && position < last)
        if (event.method === 'item/started') {
          assert.equal(starts.has(event.params.item.id), false)
          starts.add(event.params.item.id)
        }
        if (event.method === 'item/agentMessage/delta') streamed += event.params.delta
        if (event.method === 'item/completed') {
          assert.ok(starts.has(event.params.item.id), '不能先完成后开始')
          assert.equal(ends.has(event.params.item.id), false, '一个 item 只能完成一次')
          ends.add(event.params.item.id)
        }
      }
      assert.deepEqual(starts, ends, '成功终态不能遗留活动 item')
      assert.equal(streamed, 'EVENT_FIRST_' + index + '_LAST')
      const usage = events.filter((event) => event.method === 'thread/tokenUsage/updated').at(-1)
      assert.ok(usage)
      assert.equal(usage.params.turnId, turn.id)
      assert.equal(usage.params.tokenUsage.last.totalTokens, 120)
      assert.equal(
        usage.params.tokenUsage.total.totalTokens,
        120 * (index + 1),
        '重启和归档不能清零累计用量',
      )
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      const stored = history.thread.turns.find((entry: any) => entry.id === turn.id)
      assert.equal(stored.status, 'completed')
      assert.equal(
        stored.items
          .filter((item: any) => item.type === 'agentMessage')
          .map((item: any) => item.text)
          .join(''),
        streamed,
      )
    }
    const { thread: fork } = await client.request('thread/fork', { threadId: thread.id })
    await client.close()
    client = await ProtocolClient.start(home, url)
    await client.request('thread/resume', { threadId: fork.id })
    await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.threadId === fork.id && params.tokenUsage.total.totalTokens === 360,
    )
    llm.enqueue(() => [{ type: 'text', text: 'FORK_EVENTS' }])
    const { turn: forkTurn } = await client.request('turn/start', {
      threadId: fork.id,
      input: [{ type: 'text', text: '分支独立累计' }],
    })
    assert.equal((await client.completed(forkTurn.id)).status, 'completed')
    const usage = await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.turnId === forkTurn.id,
    )
    assert.equal(usage.tokenUsage.total.totalTokens, 480)
    await client.request('thread/resume', { threadId: thread.id })
    await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.threadId === thread.id && params.tokenUsage.total.totalTokens === 360,
    )
    assert.equal(llm.requests.length, 4)
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
