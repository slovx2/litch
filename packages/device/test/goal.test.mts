// 持续目标（协议原有的 thread/goal/*）：聚合面按会话转给它所在的 harness，原生 codex 的声明里带着
// features.goals，目标的通知（上游发给每条连接）原样转给客户端，没打开这个会话的连接也收得到
import assert from 'node:assert/strict'
import test from 'node:test'
import { codexRig } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { settle } from './helpers.mjs'

test('GOAL-DEVICE-001 原生 codex 声明 goals；set、get、clear 按会话转过去，目标的通知转给每条连接', async () => {
  const thread = codexThread(1, 400)
  const env = codexRig()
  try {
    const sent: { method: string; params: any }[] = []
    const goal = {
      threadId: thread.id,
      objective: '把发版说明写完',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    for (const method of ['thread/goal/set', 'thread/goal/get', 'thread/goal/clear']) {
      env.codex.handlers[method] = (params) => {
        sent.push({ method, params })
        if (method === 'thread/goal/clear') return { cleared: true }
        return { goal }
      }
    }
    const client = env.connect()
    await client.initialize(['harness'])
    // 另一条连接：没打开这个会话，只握了手
    const other = env.connect()
    await other.initialize(['harness'])
    const info = await client.call('runtime/info')
    const codex = info.harnesses.find((item: any) => item.id === 'codex')
    assert.equal(codex.features.goals, true)
    const pi = info.harnesses.find((item: any) => item.id === 'pi')
    assert.equal(pi.features?.goals, undefined, '没声明的就是不会')

    const set = await client.call('thread/goal/set', {
      threadId: thread.id,
      origin: 'user',
      objective: '把发版说明写完',
    })
    assert.equal(set.goal.objective, '把发版说明写完')
    const got = await client.call('thread/goal/get', { threadId: thread.id })
    assert.equal(got.goal.status, 'active')
    const cleared = await client.call('thread/goal/clear', { threadId: thread.id, origin: 'user' })
    assert.equal(cleared.cleared, true)
    assert.deepEqual(
      sent.map((entry) => [entry.method, entry.params.threadId, entry.params.origin]),
      [
        ['thread/goal/set', thread.id, 'user'],
        ['thread/goal/get', thread.id, undefined],
        ['thread/goal/clear', thread.id, 'user'],
      ],
    )

    env.codex.notify('thread/goal/updated', { threadId: thread.id, turnId: null, goal })
    env.codex.notify('thread/goal/cleared', { threadId: thread.id })
    for (const connection of [client, other]) {
      const updated: any = await connection.waitFor(
        (frame) => frame.method === 'thread/goal/updated',
      )
      assert.equal(updated.params.goal.objective, '把发版说明写完')
      await connection.waitFor((frame) => frame.method === 'thread/goal/cleared')
    }
    await settle()
  } finally {
    await env.close()
  }
})
