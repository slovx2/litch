import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('GOAL-001：暂停目标的归档、原生分叉、重启和清除保持独立且不触发模型', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-goal-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const threadId = thread.id
    const { goal } = await client.request('thread/goal/set', {
      threadId,
      objective: '保存独立目标上下文',
      status: 'paused',
      tokenBudget: 2000,
    })
    await client.notification('thread/goal/updated', (p) => p.threadId === threadId)
    await client.request('thread/archive', { threadId })
    assert.deepEqual((await client.request('thread/goal/get', { threadId })).goal, goal)
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.deepEqual((await client.request('thread/goal/get', { threadId })).goal, goal)
    await client.raw('thread/goal/set', { threadId, status: 'active' }, -32600)
    await client.raw('thread/goal/clear', { threadId }, -32600)
    assert.equal(llm.requests.length, 0, '归档后读取目标及重启不得恢复执行')
    await client.request('thread/unarchive', { threadId })
    assert.deepEqual((await client.request('thread/goal/get', { threadId })).goal, goal)
    assert.equal(llm.requests.length, 0, '暂停目标和元数据读取不得启动模型')
    llm.enqueue(() => [{ type: 'text', text: 'GOAL_MANUAL_TURN' }])
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '独立的用户请求' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const { thread: fork } = await client.request('thread/fork', { threadId })
    assert.deepEqual((await client.request('thread/goal/get', { threadId: fork.id })).goal, {
      ...goal,
      threadId: fork.id,
    })
    const updated = await client.request('thread/goal/set', {
      threadId: fork.id,
      objective: '分支目标',
      tokenBudget: null,
    })
    assert.equal(updated.goal.tokenBudget, null, '显式 null 必须清除预算')
    assert.equal(updated.goal.status, 'paused')
    assert.deepEqual((await client.request('thread/goal/get', { threadId })).goal, goal)
    for (const params of [
      { objective: '' },
      { objective: 4 },
      { status: 'unknown' },
      { tokenBudget: 0 },
      { tokenBudget: -1 },
      { tokenBudget: 1.5 },
    ])
      await client.raw('thread/goal/set', { threadId, ...params }, -32602)
    assert.deepEqual(
      (await client.request('thread/goal/get', { threadId })).goal,
      goal,
      '无效更新不能污染已有目标',
    )
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.deepEqual((await client.request('thread/goal/get', { threadId })).goal, goal)
    assert.equal(
      (await client.request('thread/goal/get', { threadId: fork.id })).goal.objective,
      '分支目标',
    )
    await client.request('thread/resume', { threadId })
    assert.deepEqual(await client.request('thread/goal/clear', { threadId }), { cleared: true })
    await client.notification('thread/goal/cleared', (p) => p.threadId === threadId)
    assert.deepEqual(await client.request('thread/goal/clear', { threadId }), { cleared: false })
    assert.deepEqual(await client.request('thread/goal/get', { threadId }), { goal: null })
    await client.raw('thread/goal/set', { threadId, status: 'paused' }, -32602)
    await client.request('thread/delete', { threadId: fork.id })
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await client.request('thread/goal/get', { threadId }), { goal: null })
    for (const method of ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear'])
      await client.raw(method, { threadId: fork.id, objective: '不存在', status: 'paused' }, -32602)
    assert.equal(llm.requests.length, 1, '恢复、分叉和目标维护不得额外请求模型')
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
