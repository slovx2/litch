// 交接（litch_sessions.hand_off）在设备进程里的行为：分叉到当前回合之前（不带那条无关的新消息）、
// 第一条消息说明接手的是做到一半的任务再接剩下的计划、立刻开始、不出卡、停下后唤醒父会话；只在用户发起的回合里收。
// 上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { got, litch, parent, SESSIONS, startedOn, text, treeRig, until } from './tree-kit.mjs'

const PLAN =
  '还剩两步：给 packages/api 的订单接口补上分页参数，再补 test/orders.test.mts 里的分页用例；跑通 npm test 算完。'

test('HAND-OFF-001：分叉到这个回合之前，第一条消息是说明加剩下的计划，立刻开始、不出卡，停下后唤醒父会话', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    // 之前做过一个回合：分叉要带上它
    env.pi.end(threadId, 'completed', '先看了一遍订单接口')
    const turn = await client.call('turn/start', { threadId, input: text('顺便问一下天气') })
    const current = turn.turn.id as string
    assert.notEqual(current, turnId)
    const result = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'hand_off', {
          title: '订单接口分页',
          remaining_plan: PLAN,
        })
      )?.answer,
    )
    assert.match(result.thread_id, new RegExp(`^${threadId}-fork\\d+$`))
    assert.match(result.note, /Stop that task here.*answer the user's new message/)
    // 分叉到当前回合之前
    const [fork] = env.pi.sent('thread/fork')
    assert.equal(fork.threadId, threadId)
    assert.equal(fork.beforeTurnId, current)
    // 第一条消息：接手说明、标题、剩下的计划
    const first = env.pi.sent('turn/start').find((params) => params.threadId === result.thread_id)
    const said = String(first?.input?.[0]?.text)
    assert.match(said, /You are taking over a task that .* was in the middle of/)
    assert.match(said, /Task: 订单接口分页/)
    assert.match(said, /Remaining plan:\n还剩两步/)
    // 父子关系：fork、模型起的、唤醒
    const born = await startedOn(client, result.thread_id)
    const lineage = born.params.thread.litchLineage
    assert.equal(lineage.parentThreadId, threadId)
    assert.equal(lineage.kind, 'fork')
    assert.equal(lineage.origin, 'model')
    assert.equal(lineage.wakeParent, true)
    assert.equal(lineage.proposalId, undefined)
    // 不出卡
    assert.deepEqual(env.device.sessionTree.proposals(threadId, true), [])
    assert.equal(got(client, 'litch/sessionProposal/changed').length, 0)
    // 子会话停下、父会话这个回合也结束：唤醒父会话
    env.pi.end(result.thread_id, 'completed', '分页做完了')
    env.pi.end(threadId, 'completed', '天气晴')
    await until(
      () =>
        env.pi
          .sent('turn/start')
          .some(
            (params) =>
              params.threadId === threadId &&
              parseSessionEvent(String(params.input?.[0]?.text ?? '')).event?.kind === 'wake',
          ),
      '父会话被唤醒',
    )
  } finally {
    await env.close()
  }
})

test('HAND-OFF-002：不是用户发起的回合不收；参数不对不收；引擎分叉不了回 failed', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const noPlan = await env.pi.callTool(threadId, SESSIONS, 'hand_off', { title: '缺计划' })
    assert.equal(failureOf(noPlan?.answer), 'invalid')
    assert.match(noPlan?.answer.result.contentItems[0].text, /remaining_plan is required/)
    // 引擎分叉不了（比如不支持按回合分叉）
    const fork = env.pi.handlers['thread/fork'] as NonNullable<(typeof env.pi.handlers)[string]>
    env.pi.handlers['thread/fork'] = () => {
      throw new RpcFailure(-32602, '只能从会话末尾分叉')
    }
    const refused = await env.pi.callTool(threadId, SESSIONS, 'hand_off', {
      title: '分不了',
      remaining_plan: PLAN,
    })
    assert.equal(failureOf(refused?.answer), 'failed')
    assert.match(
      refused?.answer.result.contentItems[0].text,
      /Could not hand off.*Keep the task here/,
    )
    env.pi.handlers['thread/fork'] = fork
    // 引擎自己续跑的回合
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    const self = await env.pi.callTool(threadId, SESSIONS, 'hand_off', {
      title: '引擎自己的回合',
      remaining_plan: PLAN,
    })
    assert.equal(failureOf(self?.answer), 'blocked')
    assert.match(self?.answer.result.contentItems[0].text, /Keep working here/)
    assert.equal(env.pi.sent('thread/fork').length, 1, '只有分不了的那一次')
  } finally {
    await env.close()
  }
})
