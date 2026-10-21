// 持续目标的续跑回合带来历：声明了 backgroundTasks 的连接在 turn/started、turn/completed 和历史里
// 看到 litchOrigin: goal（客户端据此不把那句内部提示画成用户气泡）；没声明的连接原样，什么都不多
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('GOAL-ORIGIN-001：续跑回合对声明了的连接带 litchOrigin goal，用户自己发的回合不带', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-goal-origin-')))
  const llm = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await llm.start(),
    false,
    'api-key',
    {},
    {
      litchExtensions: ['backgroundTasks'],
    },
  )
  try {
    llm.enqueue(() => [{ type: 'text', text: '先说一句。' }])
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: randomUUID(),
        name: 'mcp__codex_harness_adapter_goal__update_goal',
        input: { status: 'complete' },
      },
    ])
    llm.enqueue(() => [{ type: 'text', text: '目标做完了。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    const { turn: own } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    await client.completed(own.id)
    await client.request('thread/goal/set', { threadId: thread.id, objective: '说完就算完成' })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'complete',
    )
    const started = client.trace.filter(
      (message) => message.method === 'turn/started' && message.params.threadId === thread.id,
    )
    assert.equal(started.length, 2)
    assert.equal(started[0].params.turn.litchOrigin, undefined, '用户发的回合不带来历')
    assert.equal(started[1].params.turn.litchOrigin, 'goal')
    const goalTurn = started[1].params.turn.id
    assert.equal((await client.completed(goalTurn)).litchOrigin, 'goal')
    const { thread: read } = await client.request('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
    assert.deepEqual(
      read.turns.map((entry: any) => entry.litchOrigin),
      [undefined, 'goal'],
    )
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
