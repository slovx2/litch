// 卡片过期未刷新或多个客户端同时点：业务状态冲突不能冒充方法缺失。
import assert from 'node:assert/strict'
import test from 'node:test'
import { resultOf } from './fake-engine.mjs'
import { brief, got, litch, parent, SESSIONS, treeRig, until } from './tree-kit.mjs'

async function fixture() {
  const env = treeRig()
  const client = await litch(env)
  const { threadId } = await parent(client)
  const propose = async () => {
    const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '整理文件',
      ...brief('整理测试文件'),
      harness: 'claude-code',
    })
    return resultOf(call?.answer).proposal_id as string
  }
  return { env, client, threadId, propose }
}

test('忽略重复到达仍成功，只结算一次，不向引擎发送提案方法', async () => {
  const { env, client, threadId, propose } = await fixture()
  try {
    const proposalId = await propose()
    const params = { threadId, proposalId }
    const method = 'litch/sessionProposal/dismiss'
    assert.deepEqual(
      await Promise.all([client.call(method, params), client.call(method, params)]),
      [{}, {}],
    )
    const settled = env.device.sessionTree.proposal(proposalId)
    assert.equal(settled?.status, 'dismissed')
    assert.deepEqual(await client.call(method, params), {})
    assert.deepEqual(env.device.sessionTree.proposal(proposalId), settled)
    const changed = () =>
      got(client, 'litch/sessionProposal/changed')
        .flatMap((note) => note.changed)
        .filter((p) => p.id === proposalId && p.status === 'dismissed')
    await until(() => changed().length > 0, '忽略通知')
    assert.equal(changed().length, 1)
    assert.equal(env.pi.sent(method).length + env.claude.sent(method).length, 0)
    // 幂等也不能跳过提案归属校验。
    assert.equal((await client.fails(method, { ...params, threadId: 'someone-else' })).code, -32602)
  } finally {
    await env.close()
  }
})

test('已结算提案的开始/在这里做返回真实状态原因，不伪装引擎不支持', async () => {
  const { env, client, threadId, propose } = await fixture()
  try {
    const proposalId = await propose()
    const params = { threadId, proposalId }
    const accepted = await client.call('litch/sessionProposal/accept', params)
    assert.deepEqual(await client.call('litch/sessionProposal/accept', params), accepted)
    assert.equal(
      (await client.fails('litch/sessionProposal/accept', { ...params, threadId: 'someone-else' }))
        .code,
      -32602,
    )
    for (const action of ['dismiss', 'markHere', 'here']) {
      const method = `litch/sessionProposal/${action}`
      const failed = await client.fails(method, params)
      assert.equal(failed.code, -32602, `${action} 是状态冲突，不是方法缺失`)
      assert.match(failed.message, /已经开始了/)
      assert.equal(failed.data?.litch, undefined)
      assert.equal(env.pi.sent(method).length + env.claude.sent(method).length, 0)
    }
    assert.equal(env.claude.sent('thread/start').length, 1, '不能重复开子会话')
    const dismissedId = await propose()
    await client.call('litch/sessionProposal/dismiss', { threadId, proposalId: dismissedId })
    const failed = await client.fails('litch/sessionProposal/accept', {
      threadId,
      proposalId: dismissedId,
    })
    assert.equal(failed.code, -32602)
    assert.match(failed.message, /已经被用户拒绝/)
  } finally {
    await env.close()
  }
})

test('markHere 重试只回相同文本；未知提案按无效参数返回', async () => {
  const { env, client, threadId, propose } = await fixture()
  try {
    const proposalId = await propose()
    const params = { threadId, proposalId }
    const first = await client.call('litch/sessionProposal/markHere', params)
    assert.deepEqual(await client.call('litch/sessionProposal/markHere', params), first)
    assert.equal(env.device.sessionTree.proposal(proposalId)?.status, 'here')
    for (const action of ['accept', 'dismiss', 'markHere', 'here']) {
      const failed = await client.fails(`litch/sessionProposal/${action}`, {
        threadId,
        proposalId: 'missing',
      })
      assert.equal(failed.code, -32602)
      assert.match(failed.message, /没有提案/)
    }
  } finally {
    await env.close()
  }
})
