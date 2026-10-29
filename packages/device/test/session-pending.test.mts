// 真实设备路由 + 两个协议假引擎：只读待答快照、显式代答、生命周期与扩展门禁。
import assert from 'node:assert/strict'
import test from 'node:test'
import { resultOf } from './fake-engine.mjs'
import {
  brief,
  got,
  litch,
  parent,
  plain,
  SESSIONS,
  type TreeEnv,
  treeRig,
  until,
} from './tree-kit.mjs'

async function child(env: TreeEnv, parentId: string): Promise<string> {
  return resultOf(
    (
      await env.pi.callTool(parentId, SESSIONS, 'start', {
        title: '子任务',
        ...brief('检查文件'),
        initiation: 'user_asked',
        harness: 'claude-code',
      })
    )?.answer,
  ).thread_id
}

function question(env: TreeEnv, threadId: string, id: string | number, secret = false): void {
  for (const connection of env.claude.live)
    connection.send({
      id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId: env.claude.current(threadId)?.id,
        itemId: 'question',
        questions: [
          {
            id: 'q1',
            header: '范围',
            question: '改哪些目录？',
            isOther: true,
            isSecret: secret,
            options: [{ label: '只改 src', description: '' }],
          },
        ],
      },
    })
}

async function pending(env: TreeEnv, parentId: string, childId: string) {
  await until(() => env.device.sessionTree.pending.list(childId).length > 0, '请求进入设备登记表')
  return resultOf(
    (await env.pi.callTool(parentId, SESSIONS, 'read', { thread_id: childId }))?.answer,
  ).pending_requests[0]
}

async function respond(
  env: TreeEnv,
  source: string,
  target: string,
  requestId: string,
  answer: unknown,
) {
  const result = (
    await env.pi.callTool(source, SESSIONS, 'respond', {
      thread_id: target,
      request_id: requestId,
      answer,
    })
  )?.answer.result
  return { success: result.success, ...JSON.parse(result.contentItems[0].text) }
}

test('SESSION-PENDING-001：问题与审批显式代答，read/通知有内容，双端快照与历史留来源', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const old = await plain(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId)
    question(env, childId, 'q-rpc')
    const request = await pending(env, threadId, childId)
    assert.equal(request.kind, 'question')
    assert.equal(request.questions[0].question, '改哪些目录？')
    assert.notEqual(request.id, 'q-rpc')
    await until(
      () => got(client, 'litch/thread/pending/changed').length > 0,
      '声明过的连接收到快照',
    )
    assert.equal(got(old, 'litch/thread/pending/changed').length, 0)
    const answered = await respond(env, threadId, childId, request.id, {
      answers: { q1: ['只改 src'] },
    })
    assert.equal(answered.success, true)
    assert.equal(answered.response.sourceThreadId, threadId)
    assert.equal(answered.response.parent, true)
    await until(
      () => [...env.claude.live].some((c) => c.answers.some((a) => a.id === 'q-rpc')),
      '原连接收到问题答案',
    )
    const raw = [...env.claude.live].flatMap((c) => c.answers).find((a) => a.id === 'q-rpc')
    assert.deepEqual(raw.result, { answers: { q1: { answers: ['只改 src'] } } })
    assert.equal(env.device.sessionTree.pending.list(childId).length, 0)
    const expired = await respond(env, threadId, childId, request.id, {
      answers: { q1: ['再答一次'] },
    })
    assert.equal(expired.error.code, 'request_expired')
    assert.equal(expired.success, false)
    const history = await client.call('thread/read', { threadId: childId, includeTurns: true })
    assert.equal(history.thread.litchDelegatedResponses[0].sourceThreadId, threadId)
    const unaware = await old.call('thread/read', { threadId: childId, includeTurns: true })
    assert.equal(unaware.thread.litchDelegatedResponses, undefined)
    assert.equal(unaware.thread.litchPendingRequests, undefined)
    const approvalId = env.claude.approval(childId)
    const approval = await pending(env, threadId, childId)
    assert.equal(approval.kind, 'approval')
    const approved = await respond(env, threadId, childId, approval.id, { decision: 'accept' })
    assert.equal(approved.success, true)
    await until(
      () => [...env.claude.live].some((c) => c.answers.some((a) => a.id === approvalId)),
      '原连接收到审批',
    )
    assert.equal(env.device.sessionTree.store.responses(childId).length, 2)
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-002：不归属、秘密字段、非法答案、无权限均结构化拒绝，普通 send 和回报不作答', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId)
    question(env, childId, 'ordinary')
    const request = await pending(env, threadId, childId)
    assert.equal(
      (await respond(env, threadId, threadId, request.id, { answers: { q1: ['x'] } })).error.code,
      'request_mismatch',
    )
    assert.equal(
      (await respond(env, threadId, childId, request.id, { answers: {} })).error.code,
      'invalid_answer',
    )
    await env.pi.callTool(threadId, SESSIONS, 'send', {
      thread_id: childId,
      message: '选择第一项，这只是消息',
    })
    assert.equal(env.device.sessionTree.pending.list(childId)[0]?.id, request.id)
    await until(
      () => env.pi.sent('turn/steer').some((p) => String(p.input?.[0]?.text).includes('needsUser')),
      'needsUser 交给父回合',
    )
    const note = env.pi
      .sent('turn/steer')
      .find((p) => String(p.input?.[0]?.text).includes('needsUser'))
    assert.ok(note.input[0].text.includes(request.id))
    assert.ok(note.input[0].text.includes('改哪些目录'))
    assert.equal(env.device.sessionTree.pending.list(childId)[0]?.id, request.id)
    const stranger = await parent(client, false)
    env.pi.selfTurn(stranger.threadId)
    assert.equal(
      (await respond(env, stranger.threadId, childId, request.id, { answers: { q1: ['x'] } })).error
        .code,
      'forbidden',
    )
    question(env, childId, 'secret', true)
    await until(() => env.device.sessionTree.pending.list(childId).length === 2, '秘密题进入集合')
    const secret = env.device.sessionTree.pending.list(childId).find((q) => !q.canRespond)
    assert.ok(secret)
    assert.equal(secret.questions, undefined)
    assert.equal(
      (await respond(env, threadId, childId, secret.id, { answers: { q1: ['password'] } })).error
        .code,
      'secret_requires_user',
    )
    for (const connection of env.claude.live)
      connection.send({
        id: 'form',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: childId,
          message: '登录',
          requestedSchema: { type: 'object', properties: { password: { type: 'string' } } },
        },
      })
    await until(() => env.device.sessionTree.pending.list(childId).length === 3, '秘密表单进入集合')
    const form = env.device.sessionTree.pending.list(childId).find((q) => q.kind === 'form')
    assert.ok(form)
    assert.equal(
      (
        await respond(env, threadId, childId, form.id, {
          action: 'accept',
          content: { password: 'secret' },
        })
      ).error.code,
      'secret_requires_user',
    )
    assert.equal(env.device.sessionTree.store.responses(childId).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-003：同号请求按连接及 ID 类型隔离；结束、已解决、断连让 token 失效', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId)
    question(env, childId, 1)
    question(env, childId, '1')
    await until(
      () => env.device.sessionTree.pending.list(childId).length === 2,
      '数字和字符串号独立',
    )
    env.claude.notify('serverRequest/resolved', { requestId: 1 })
    await until(() => env.device.sessionTree.pending.list(childId).length === 1, '只解决数字号')
    const left = env.device.sessionTree.pending.list(childId)[0]
    assert.ok(left)
    const link = await env.device.sessionTree.link('claude-code')
    link.close()
    assert.equal(env.device.sessionTree.pending.list(childId).length, 0)
    assert.equal(
      (await respond(env, threadId, childId, left.id, { answers: { q1: ['x'] } })).error.code,
      'request_expired',
    )
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-005：用户回合可代答其他会话；下一自发回合不继承权限', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const owner = await parent(client)
    const childId = await child(env, owner.threadId)
    const source = await parent(client)
    question(env, childId, 'outside-parent')
    const request = await pending(env, owner.threadId, childId)
    const result = await respond(env, source.threadId, childId, request.id, {
      answers: { q1: ['只改 src'] },
    })
    assert.equal(result.success, true)
    assert.equal(result.response.parent, false)
    assert.equal(result.response.sourceThreadId, source.threadId)
    env.pi.end(source.threadId)
    env.pi.selfTurn(source.threadId)
    question(env, childId, 'next-turn')
    const next = await pending(env, owner.threadId, childId)
    assert.equal(
      (await respond(env, source.threadId, childId, next.id, { answers: { q1: ['只改 src'] } }))
        .error.code,
      'forbidden',
    )
    assert.equal(env.device.sessionTree.pending.list(childId)[0]?.id, next.id)
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-006：已解决的 needsUser 队列不制造空唤醒或空回报', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client, false)
    const stale = {
      threadId: 'resolved-child',
      title: '已解决',
      status: 'needsUser' as const,
      excerpt: '',
    }
    env.device.sessionTree.store.addNote(threadId, stale, true)
    const starts = env.pi.sent('turn/start').length
    assert.equal(await env.device.sessionTree.deliver(threadId), 'none')
    assert.equal(env.pi.sent('turn/start').length, starts)
    assert.deepEqual(env.device.sessionTree.store.notes(threadId), [])
    env.device.sessionTree.store.addNote(threadId, stale, true)
    const input = [{ type: 'text', text: '继续原任务', text_elements: [] }]
    assert.equal(env.device.sessionTree.beforeDeviceTurn(threadId, input), input)
  } finally {
    await env.close()
  }
})

test('SESSION-PENDING-004：用户先答立即撤销 token；权限审批只授予原请求范围；回合结束撤销未答项', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId)
    await client.call('thread/resume', { threadId: childId })
    question(env, childId, 'user-first')
    const first = await pending(env, threadId, childId)
    const shown = await client.waitFor((frame) => frame.id === 'user-first')
    client.answer(shown.id, { answers: { q1: { answers: ['用户答案'] } } })
    await until(
      () => !env.device.sessionTree.pending.list(childId).length,
      '不用等引擎 resolved 就撤销代答 token',
    )
    assert.equal(
      (await respond(env, threadId, childId, first.id, { answers: { q1: ['模型答案'] } })).error
        .code,
      'request_expired',
    )
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ['/work/app'], write: [] },
    }
    for (const connection of env.claude.live)
      connection.send({
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { threadId: childId, turnId: env.claude.current(childId)?.id, permissions },
      })
    const permission = await pending(env, threadId, childId)
    assert.equal(
      (await respond(env, threadId, childId, permission.id, { decision: 'accept' })).success,
      true,
    )
    await until(
      () => [...env.claude.live].some((c) => c.answers.some((a) => a.id === 'permissions')),
      '权限答案送回',
    )
    assert.deepEqual(
      [...env.claude.live].flatMap((c) => c.answers).find((a) => a.id === 'permissions').result,
      { permissions, scope: 'turn' },
    )
    question(env, childId, 'end-now')
    const last = await pending(env, threadId, childId)
    env.claude.end(childId)
    await until(() => !env.device.sessionTree.pending.list(childId).length, '回合结束作废请求')
    assert.equal(
      (await respond(env, threadId, childId, last.id, { answers: { q1: ['迟到'] } })).error.code,
      'request_expired',
    )
  } finally {
    await env.close()
  }
})
