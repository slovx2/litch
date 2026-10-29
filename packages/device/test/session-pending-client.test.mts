// 客户端工具执行不等于等用户；只有显式挂出的审批才进入父会话待处理集合。
import assert from 'node:assert/strict'
import test from 'node:test'
import { card } from './approvals-kit.mjs'
import { codexRig } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { settle } from './helpers.mjs'
import { until } from './tree-kit.mjs'

const threadId = codexThread(1, 400).id

test('SESSION-PENDING-CLIENT-001：慢客户端工具及成功结果不进入待用户集合，多连接只执行一次', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'sessionTree', 'clientTools'], {
      litchClientTools: { namespaces: ['litch_browser'] },
    })
    const other = env.connect()
    await other.initialize(['harness', 'sessionTree'])
    for (const c of [client, other]) await c.call('thread/resume', { threadId })
    await client.call('turn/start', { threadId, input: [{ type: 'text', text: '打开本地页面' }] })
    await env.device.sessionTree.link('codex')
    const { id } = env.codex.toolCall(threadId, 'litch_browser')
    const call = await client.waitFor((f) => f.method === 'item/tool/call')
    // 不等十秒：任何执行请求都不应登记，因而永远不触发等待阈值。
    await settle(80)
    assert.deepEqual(env.device.sessionTree.pendingRequests(threadId), [])
    assert.equal(env.device.sessionTree.waitingOnUser(threadId), false)
    client.answer(call.id, { success: true, contentItems: [{ type: 'inputText', text: 'Loaded' }] })
    await settle(80)
    assert.equal(
      env.codex.connections.flatMap((c) => c.answers).filter((a) => a.id === id).length,
      1,
    )
    assert.deepEqual(env.device.sessionTree.pendingRequests(threadId), [])
    assert.equal(env.device.sessionTree.waitingOnUser(threadId), false)
    // 真审批仍登记，不能为了消除误报把所有请求都忽略。
    env.codex.commandApproval(threadId)
    await until(() => env.device.sessionTree.pendingRequests(threadId).length === 1, '真审批登记')
    assert.equal(env.device.sessionTree.pendingRequests(threadId)[0]?.kind, 'approval')
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-CLIENT-002：客户端显式登录审批进父会话快照，关闭/断连清除，未声明不收到', async () => {
  const env = codexRig()
  try {
    env.device.sessionTree.host.needsUserMs = 0
    const client = env.connect()
    await client.initialize(['harness', 'sessionTree', 'clientApprovals'])
    const other = env.connect()
    await other.initialize(['harness'])
    const value = card({ threadId })
    await client.call('litch/approval/open', value)
    const snapshot = (await client.call('thread/read', { threadId })).thread.litchPendingRequests
    assert.equal(env.device.sessionTree.waitingOnUser(threadId), true)
    assert.equal(snapshot[0].kind, 'clientApproval')
    assert.equal(snapshot[0].canRespond, false)
    assert.equal(snapshot[0].title, 'GitHub')
    assert.ok(snapshot[0].summary.includes('https://github.com'))
    assert.equal(
      (await other.call('thread/read', { threadId })).thread.litchPendingRequests,
      undefined,
    )
    assert.equal(
      other.notifications.some((n) => n.method === 'litch/thread/pending/changed'),
      false,
    )
    await client.call('litch/approval/close', { id: value.id })
    assert.deepEqual(env.device.sessionTree.pendingRequests(threadId), [])
    assert.equal(env.device.sessionTree.waitingOnUser(threadId), false)
    await client.call('litch/approval/open', value)
    client.close()
    await until(
      () => env.device.sessionTree.pendingRequests(threadId).length === 0,
      '执行端断连收卡',
    )
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-CLIENT-003：空白提问的标题和摘要都有兜底', async () => {
  const env = codexRig()
  try {
    await env.device.sessionTree.link('codex')
    for (const c of env.codex.live)
      c.send({
        id: 'blank',
        method: 'item/tool/requestUserInput',
        params: { threadId, questions: [{ id: 'q', question: '  ', options: [] }] },
      })
    await until(() => env.device.sessionTree.pendingRequests(threadId).length === 1, '空题登记')
    const request = env.device.sessionTree.pendingRequests(threadId)[0]
    assert.ok(request?.title.trim())
    assert.ok(request?.summary.trim())
  } finally {
    await env.close()
  }
})
