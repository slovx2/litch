// 没有客户端连着时模型调设备工具（litch_sessions）：引擎只把调用交给发起回合的连接或订阅着会话的连接，
// 客户端断开、或者引擎自己续跑的回合没有客户端订阅着时，设备进程的连接得先跟上这个会话（session-tree.mts 的 follow），
// 收尾、任务卡照常落库、模型照常拿到结果；客户端之后连上从设备读到卡片。上游是假引擎（fake-engine.mts，按订阅挑执行方）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { resultOf } from './fake-engine.mjs'
import type { TestClient } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  litch,
  SESSIONS,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

/** 在 pi 上建一个带 litch_sessions 的会话（像 Litch 客户端建的），再发一个用户回合 */
async function withTools(client: TestClient): Promise<string> {
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
  })
  const threadId = started.thread.id as string
  await client.call('turn/start', { threadId, input: text('帮我看看还剩什么') })
  return threadId
}

/** 订阅着这个会话、还连着的连接里有没有不是客户端的（设备进程自己的） */
const followed = (env: TreeEnv, threadId: string, clients: TestClient[]) => {
  const subscribers = (env.pi.subscribers.get(threadId) ?? []).filter((one) => one.open)
  return subscribers.length > clients.length || (subscribers.length > 0 && clients.length === 0)
}

test('SESSION-OFFLINE-001：回合进行中客户端断开，设备进程接着订阅；模型照常收尾出卡片，客户端回来读得到', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    client.close()
    await until(() => followed(env, threadId, []), '客户端断开后设备进程的连接跟上这个会话')
    const call = await env.pi.callTool(threadId, SESSIONS, 'wrap_up', {
      suggestions: [{ title: '补集成测试', ...brief('补订单服务的集成测试。') }],
    })
    assert.ok(call, '没有客户端也挑得出执行方')
    const [made] = resultOf(call.answer).suggestions
    assert.ok(made.proposal_id, '提案照常落库')
    env.pi.end(threadId, 'completed', '做完了')
    const back = await litch(env)
    const listed = await back.call('litch/sessionProposal/list', { threadId })
    assert.deepEqual(
      listed.proposals.map((one: any) => [one.id, one.title, one.status]),
      [[made.proposal_id, '补集成测试', 'pending']],
    )
  } finally {
    await env.close()
  }
})

test('SESSION-OFFLINE-002：有后台任务在跑的会话，设备进程跟着；客户端走了以后任务跑完、引擎自己续跑的回合里调收尾也有执行方', async () => {
  const env = treeRig({ releaseMs: 50 })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    env.pi.end(threadId, 'completed', '在后台跑着')
    const task = { id: 'b1', kind: 'shell', title: 'npm test', status: 'running', startedAt: 1 }
    env.pi.notify(BACKGROUND_TASKS_NOTIFICATION.changed, {
      threadId,
      tasks: [task],
      wakesOnFinish: true,
    })
    await until(
      () => followed(env, threadId, [client]),
      '有后台任务在跑：设备进程的连接跟上这个会话',
    )
    client.close()
    env.pi.notify(BACKGROUND_TASKS_NOTIFICATION.changed, {
      threadId,
      tasks: [{ ...task, status: 'completed', endedAt: 2 }],
      wakesOnFinish: true,
    })
    env.pi.selfTurn(threadId)
    const call = await env.pi.callTool(threadId, SESSIONS, 'wrap_up', { suggestions: [] })
    assert.ok(call, '引擎自己续跑的回合里也挑得出执行方')
    assert.equal(call.answer.result.success, true)
    env.pi.end(threadId)
    await until(() => !followed(env, threadId, []), '回合结束、后台也跑完了：退订', 3000)
  } finally {
    await env.close()
  }
})

test('SESSION-OFFLINE-003：会话空着、客户端都走了，引擎自己开的回合（Claude 收到别的会话发来的消息）里调设备工具，交给设备进程留的连接（anyThread）', async () => {
  const env = treeRig({ releaseMs: 50 })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    env.pi.end(threadId, 'completed', '做完了')
    client.close()
    await until(() => !followed(env, threadId, []), '没有回合在跑：设备进程不订阅这个会话', 3000)
    env.pi.selfTurn(threadId)
    const call = await env.pi.callTool(threadId, SESSIONS, 'wrap_up', { suggestions: [] })
    assert.ok(call, '没人订阅也挑得出执行方')
    assert.equal(call.answer.result.success, true)
    assert.ok(call.connection.open, '客户端都断了，接的是设备进程留的那条')
  } finally {
    await env.close()
  }
})
