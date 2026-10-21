// 会话树的连接订阅了就要退：为读父会话的设置（提案、开子会话）、开提醒回合订阅的会话，用不着了隔 releaseMs 退订。
// 原生 codex 只卸载没人订阅的会话，卸载了才放开写入锁；设备进程常驻，不退的话 ChatGPT.app 一直打不开这个会话。
// 上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import { brief, ECHO_SPEC, litch, parent, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const RELEASE_MS = 30

const unsubscribed = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi.sent('thread/unsubscribe').filter((params) => params.threadId === threadId).length

const resumed = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi.sent('thread/resume').filter((params) => params.threadId === threadId).length

test('SESSION-RELEASE-001：提案时为读父会话的设置订阅了它：回合还在跑时不退，回合结束后退订', async () => {
  const env = treeRig({ releaseMs: RELEASE_MS })
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const answer = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '补集成测试',
      ...brief('补订单服务的集成测试。'),
      initiation: 'propose',
    })
    assert.ok(resultOf(answer?.answer).proposal_id, '落成一张提案')
    assert.equal(resumed(env, threadId), 1, '设备进程的连接恢复过父会话，读它的设置')
    await settle(RELEASE_MS * 4)
    assert.equal(unsubscribed(env, threadId), 0, '父会话这一回合还在跑，不退')
    env.pi.end(threadId, 'completed', '做完了')
    await until(() => unsubscribed(env, threadId) === 1, '回合结束后退订')
    await settle(RELEASE_MS * 4)
    assert.equal(unsubscribed(env, threadId), 1, '只退一次')
  } finally {
    await env.close()
  }
})

test('SESSION-RELEASE-002：提醒回合接着用这份订阅，提醒回合结束才退；退了之后再要用就重新订阅', async () => {
  const env = treeRig({ releaseMs: RELEASE_MS })
  try {
    const client = await litch(env)
    const started = await client.call('thread/start', {
      harness: 'pi',
      cwd: '/work/app',
      dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
    })
    const threadId = started.thread.id as string
    await client.call('turn/start', { threadId, input: text('帮我看看还剩什么') })
    resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '甲',
          ...brief('甲'),
          initiation: 'propose',
        })
      )?.answer,
    )
    // 用户回合没调收尾：设备进程替它开提醒回合
    env.pi.end(threadId, 'completed', '做完了')
    await until(() => env.pi.running(threadId), '提醒回合在跑')
    await settle(RELEASE_MS * 4)
    assert.equal(unsubscribed(env, threadId), 0, '提醒回合在跑，不退')
    env.pi.end(threadId, 'completed', '好')
    await until(() => unsubscribed(env, threadId) === 1, '提醒回合结束后退订')
    // 退了之后又要盯（唤醒、发消息走的都是 watch）：重新恢复一次
    const before = resumed(env, threadId)
    await env.device.sessionTree.watch('pi', threadId)
    assert.equal(resumed(env, threadId), before + 1)
  } finally {
    await env.close()
  }
})
