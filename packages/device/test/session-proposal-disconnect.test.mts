// 两个客户端共用设备服务：桌面端断开以后，手机仍能开始任务并直接收到提案状态通知。
import assert from 'node:assert/strict'
import test from 'node:test'
import { resultOf } from './fake-engine.mjs'
import { brief, got, litch, parent, SESSIONS, treeRig, until } from './tree-kit.mjs'

test('提案状态不依赖桌面连接：桌面断开后手机接受和在这里做都收到 changed', async () => {
  const env = treeRig()
  try {
    const desktop = await litch(env)
    const phone = await litch(env)
    const { threadId } = await parent(desktop)
    const ids: string[] = []
    for (const title of ['开始任务', '在这里做任务']) {
      const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
        title,
        ...brief('整理文件。'),
        harness: 'claude-code',
      })
      ids.push(resultOf(call?.answer).proposal_id)
    }
    const [acceptId, hereId] = ids
    assert.ok(acceptId && hereId)
    const method = 'litch/sessionProposal/changed'
    await until(() => got(phone, method).length === 2, '手机应收到两个提案')
    desktop.close()
    const accepted = await phone.call('litch/sessionProposal/accept', { proposalId: acceptId })
    assert.equal(accepted.threadId, 'claude-code-t1')
    assert.ok(env.claude.sent('turn/start').some((p) => p.threadId === accepted.threadId))
    const marked = await phone.call('litch/sessionProposal/markHere', { proposalId: hereId })
    assert.match(marked.text, /在这里做任务/)
    await until(() => got(phone, method).length === 4, '桌面断线后两次操作都应通知手机')
    const changed = got(phone, method)
      .slice(2)
      .flatMap((note) => note.changed)
    assert.deepEqual(
      changed.map((p) => [p.id, p.status]),
      [
        [acceptId, 'started'],
        [hereId, 'here'],
      ],
    )
    assert.equal(changed[0].startedThreadId, accepted.threadId)
  } finally {
    await env.close()
  }
})
