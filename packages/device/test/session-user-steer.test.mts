// 自发回合收到用户插话后按用户回合处理；设备回报与会话间消息不能取得这项权限。
import assert from 'node:assert/strict'
import test from 'node:test'
import { failureOf, resultOf } from './fake-engine.mjs'
import { brief, litch, parent, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

test('SESSION-USER-STEER-001：自发回合夹入用户输入后能直接派子会话，后续回报不覆盖，下一回合不继承', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '用户回合结束')
    env.pi.selfTurn(threadId)
    const turnId = env.pi.current(threadId)?.id
    assert.ok(turnId)
    await until(() => env.device.sessionTree.activeTurn(threadId) === turnId, '自发回合开始')
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), false)
    const link = await env.device.sessionTree.link('pi')
    // 设备连接插入回报，不能当成用户；消息正文不是判断依据。
    await link.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: text('子会话回报'),
    })
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), false)
    await client.call('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: text('请开子会话整理日志'),
    })
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), true)
    assert.equal(env.device.sessionTree.isUserTurn('claude-code', turnId), false)
    await link.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: text('另一个子会话回报'),
    })
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), true)
    const result = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '整理日志',
          ...brief('整理日志'),
          initiation: 'user_asked',
          harness: 'claude-code',
        })
      )?.answer,
    )
    assert.equal(typeof result.thread_id, 'string')
    assert.equal(env.claude.sent('thread/start').length, 1)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '本回合结束')
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), false)
    env.pi.selfTurn(threadId)
    const next = env.pi.current(threadId)?.id
    assert.ok(next)
    assert.notEqual(next, turnId)
    assert.equal(env.device.sessionTree.isUserTurn('pi', next), false)
  } finally {
    await env.close()
  }
})

test('SESSION-USER-STEER-002：插话失败不授予用户回合权限', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '用户回合结束')
    env.pi.selfTurn(threadId)
    const turnId = env.pi.current(threadId)?.id
    assert.ok(turnId)
    await assert.rejects(
      client.call('turn/steer', {
        threadId,
        expectedTurnId: 'expired',
        input: text('请开子会话'),
      }),
    )
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), false)
    const result = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '未收到的请求',
          ...brief('未收到的请求'),
          initiation: 'propose',
        })
      )?.answer,
    )
    assert.equal(typeof result.proposal_id, 'string')
    assert.equal(result.thread_id, undefined)
    const accepted = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: result.proposal_id,
    })
    assert.equal(
      failureOf(accepted?.answer),
      'blocked',
      'accept 仍要求用户回合，直接启动的放开不扩大其他权限',
    )
  } finally {
    await env.close()
  }
})
