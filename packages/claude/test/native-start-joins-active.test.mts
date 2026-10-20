import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 有活动回合时 turn/start 和上游 codex 一样并进那个回合（start_or_steer）：回执里是活动回合的号，
// 这句话由 CLI 接着处理，不另开回合；回合结束后拿旧回合号 steer 被拒。

test('START-JOIN-001：活动回合期间 turn/start 并进活动回合并回它的号，结束后旧回合号的 steer 被拒', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-start-join-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    model.enqueue(async () => {
      arrived()
      await gate
      return [{ type: 'text', text: 'FIRST_ANSWER' }]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /JOINED_INPUT/)
      return [{ type: 'text', text: 'SECOND_ANSWER' }]
    })
    const { thread } = await client.request('thread/start', { cwd: home })
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'FIRST_INPUT' }],
    })
    await firstArrived
    const joined = await client.request('turn/start', {
      threadId: thread.id,
      clientUserMessageId: 'joined-message',
      input: [{ type: 'text', text: 'JOINED_INPUT' }],
    })
    assert.equal(joined.turn.id, first.turn.id, '回执里是活动回合')
    assert.equal(joined.turn.status, 'inProgress')
    // 同一个消息号重发：仍是这个回合，不再送一次
    const again = await client.request('turn/start', {
      threadId: thread.id,
      clientUserMessageId: 'joined-message',
      input: [{ type: 'text', text: 'JOINED_INPUT' }],
    })
    assert.equal(again.turn.id, first.turn.id)
    release()
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    model.assertConsumed()
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(read.thread.turns.length, 1, '没有另开回合')
    const items = read.thread.turns[0].items
    const users = items.filter((item: any) => item.type === 'userMessage')
    assert.equal(users.length, 2)
    assert.equal(users[1].clientId, 'joined-message')
    assert.ok(
      items.some((item: any) => item.type === 'agentMessage' && item.text === 'SECOND_ANSWER'),
    )
    await client.raw(
      'turn/steer',
      {
        threadId: thread.id,
        expectedTurnId: first.turn.id,
        input: [{ type: 'text', text: 'STALE' }],
      },
      -32009,
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
