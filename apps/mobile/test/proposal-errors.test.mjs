// 真设备层的业务拒绝经过核心错误转换和手机共用文案，不能变成“引擎不支持”。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcError } from '../../../packages/core/src/connection/rpc.mts'
import { channelFailure } from '../../../packages/core/src/device/faults.mts'
import { resultOf } from '../../../packages/device/test/fake-engine.mts'
import { brief, litch, parent, SESSIONS, treeRig } from '../../../packages/device/test/tree-kit.mts'
import { whyNot } from '../../../packages/ui/src/app/errors.ts'
import { translator } from '../../../packages/ui/src/i18n/index.ts'

const t = translator('zh-CN')
const shown = (failure) =>
  t('proposal.failed', {
    reason: whyNot(channelFailure(new RpcError(failure.code, failure.message, failure.data)), t),
  })

test('提案状态冲突给出具体原因，已完成的同一操作重试成功', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    for (const action of ['dismiss', 'accept', 'markHere']) {
      const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: action,
        ...brief('测试卡片'),
        harness: 'claude-code',
      })
      const proposalId = resultOf(call.answer).proposal_id
      const method = `litch/sessionProposal/${action}`
      const params = { threadId, proposalId }
      const result = await client.call(method, params)
      assert.deepEqual(await client.call(method, params), result)
      const incompatible = action === 'dismiss' ? 'accept' : 'dismiss'
      const failure = await client.fails(`litch/sessionProposal/${incompatible}`, params)
      const message = shown(failure)
      assert.ok(message.includes(failure.message), '界面必须保留设备给出的具体状态原因')
      assert.ok(!message.includes('引擎不支持'))
    }
    // 真正缺失的方法仍保留“不支持”，不能为消除误报而吞掉所有 -32601。
    const missing = await client.fails('litch/sessionProposal/notARealMethod', { threadId })
    assert.equal(missing.code, -32601)
    assert.ok(shown(missing).includes('引擎不支持'))
  } finally {
    await env.close()
  }
})
