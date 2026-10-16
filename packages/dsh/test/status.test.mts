import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { type MockBlock, scripted } from './mock-model.mjs'

// 线程状态上“在等用户”的标记（activeFlags）：客户端侧栏的“等你”记号只看它。报线程状态的每一处都要带上：
// thread/status/changed、回合开始、会话对象（thread/read、thread/list、thread/resume 给的）。此前只有审批、
// 提问开始等的那一刻单发一条带标记的通知，别处都写死“没在等”，客户端等着的时候重读一次会话，标记就没了；
// 同时等着两件事时，先等完的那件把标记整个清掉。对着 dsh 0.2.0-rc.2。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const escalate: MockBlock = {
  type: 'tool_use',
  name: 'bash',
  input: {
    command: 'echo status',
    description: '需要提权的命令',
    sandbox_permissions: 'danger-full-access',
    justification: '测试审批时的线程状态。',
  },
}
const ask: MockBlock = {
  type: 'tool_use',
  name: 'ask_user_question',
  input: { questions: [{ id: 'pick', question: '选哪个？', options: [{ label: '甲' }] }] },
}
const respond = scripted({
  APPROVE: [[escalate], [{ type: 'text', chunks: ['跑完了。'] }]],
  ASK: [[ask], [{ type: 'text', chunks: ['知道了。'] }]],
  PLAIN: [[{ type: 'text', chunks: ['好的。'] }]],
})

type Scene = Awaited<ReturnType<typeof isolate>> & {
  server: DshServer
  desktop: ReturnType<typeof client>
}

async function scene(): Promise<Scene> {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
  desktop.onRequest(() => undefined)
  return { ...env, server, desktop }
}

// 等这条连接收到第 n 个（从 1 数）method 请求。
async function request(c: ReturnType<typeof client>, method: string, n = 1): Promise<any> {
  for (let waited = 0; waited < 20000; waited += 20) {
    const found = c.requests.filter((entry) => entry.method === method)
    if (found.length >= n) return found[n - 1]
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等 ${method} 超时`)
}

// 这条连接上收到的这个线程的状态，按先后。
const statuses = (c: ReturnType<typeof client>, threadId: string): any[] =>
  c.notifications
    .filter(
      (entry) => entry.method === 'thread/status/changed' && entry.params.threadId === threadId,
    )
    .map((entry) => entry.params.status)

// 会话对象上的状态：thread/read、thread/list、thread/resume 各给一份。
async function reported(c: ReturnType<typeof client>, threadId: string): Promise<any[]> {
  const read = (await c.call('thread/read', { threadId })).thread.status
  const { data } = await c.call('thread/list', { limit: 50 })
  const listed = data.find((thread: any) => thread.id === threadId)?.status
  const resumed = (await c.call('thread/resume', { threadId })).thread.status
  return [read, listed, resumed]
}

const waiting = (...flags: string[]) => ({ type: 'active', activeFlags: flags })
const idle = { type: 'idle' }

test('STATUS-DSH-001：等审批时线程标着在等审批：通知、重读、重列、另一条连接订阅都一样；裁决之后去掉', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const other = client(s.server)
    await other.call('initialize', { clientInfo: { name: 'other', version: '0' } })
    other.onRequest(() => undefined)
    const threadId = (
      await s.desktop.call('thread/start', { cwd: s.cwd, permissions: ':workspace' })
    ).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('APPROVE 跑') })
    const asked = await request(s.desktop, 'item/commandExecution/requestApproval')
    const flagged = waiting('waitingOnApproval')
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), flagged)
    // 等着的时候重读、重列、再订阅，另一条连接也来读：会话对象上都是在等审批，也没有通知把它盖掉
    assert.deepEqual(await reported(s.desktop, threadId), [flagged, flagged, flagged])
    assert.deepEqual(await reported(other, threadId), [flagged, flagged, flagged])
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), flagged)

    await s.desktop.respond(asked, { decision: 'accept' })
    const done = await s.desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    // 裁决之后回合接着跑：没在等了；回合结束是空闲
    assert.deepEqual(statuses(s.desktop, threadId).slice(-2), [waiting(), idle])
    assert.deepEqual(await reported(s.desktop, threadId), [idle, idle, idle])
    // 下一个回合开始时不带上一回合的标记
    const seen = statuses(s.desktop, threadId).length
    const next = await s.desktop.call('turn/start', { threadId, input: text('PLAIN 说') })
    await s.desktop.until('turn/completed', (params) => params.turn.id === next.turn.id)
    assert.deepEqual(statuses(s.desktop, threadId).slice(seen), [waiting(), idle])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('STATUS-DSH-002：等回答时线程标着在等用户：通知、重读、重列、再订阅都一样；答了之后去掉', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('ASK 问') })
    const asked = await request(s.desktop, 'item/tool/requestUserInput')
    const flagged = waiting('waitingOnUserInput')
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), flagged)
    assert.deepEqual(await reported(s.desktop, threadId), [flagged, flagged, flagged])
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), flagged)
    await s.desktop.respond(asked, { answers: { pick: { answers: ['甲'] } } })
    const done = await s.desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    assert.deepEqual(statuses(s.desktop, threadId).slice(-2), [waiting(), idle])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('STATUS-DSH-003：同时等着审批和提问，两个标记都在；先等完的那件只去掉自己的标记', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const threadId = (
      await s.desktop.call('thread/start', { cwd: s.cwd, permissions: ':workspace' })
    ).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('ASK 问') })
    const question = await request(s.desktop, 'item/tool/requestUserInput')
    // dsh 0.2.0-rc.2 把同一步里的几个工具调用一个接一个地执行，凑不出两件同时在等：
    // 这里在提问等着的时候直接交给入口一个审批事件
    const outcome = (s.server as any).waterfall(
      {
        event: 'approval/request',
        eventId: 'extra',
        agentId: threadId,
        request: { callId: 'extra-call', reason: '同时来的审批' },
      },
      new AbortController().signal,
    )
    const approval = await request(s.desktop, 'item/commandExecution/requestApproval')
    // 次序照上游：审批在前、提问在后
    const both = waiting('waitingOnApproval', 'waitingOnUserInput')
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), both)
    assert.deepEqual(await reported(s.desktop, threadId), [both, both, both])
    await s.desktop.respond(approval, { decision: 'decline' })
    assert.deepEqual(await outcome, { kind: 'result', value: 'rejected' })
    const asking = waiting('waitingOnUserInput')
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), asking)
    assert.deepEqual(await reported(s.desktop, threadId), [asking, asking, asking])
    await s.desktop.respond(question, { answers: { pick: { answers: ['甲'] } } })
    const done = await s.desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    assert.deepEqual(statuses(s.desktop, threadId).slice(-2), [waiting(), idle])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('STATUS-DSH-004：审批比回合开始先到，回合开始时报的状态带着还在等的审批', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const threadId = (
      await s.desktop.call('thread/start', { cwd: s.cwd, permissions: ':workspace' })
    ).thread.id
    // dsh 的审批走的是瀑布事件那条流，回合事件走另一条：这里直接把一个审批事件交给入口，
    // 那时这个会话还没有回合
    const outcome = (s.server as any).waterfall(
      {
        event: 'approval/request',
        eventId: 'early',
        agentId: threadId,
        request: { callId: 'early-call', reason: '先到的审批' },
      },
      new AbortController().signal,
    )
    const asked = await request(s.desktop, 'item/commandExecution/requestApproval')
    // 没有回合在跑、有审批在等也算 active（照上游）
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), waiting('waitingOnApproval'))
    assert.deepEqual(
      (await s.desktop.call('thread/read', { threadId })).thread.status,
      waiting('waitingOnApproval'),
    )
    const seen = s.desktop.notifications.length
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('PLAIN 说') })
    await s.desktop.until('turn/started', (params) => params.turn.id === turn.id)
    const started = s.desktop.notifications
      .slice(seen)
      .find((entry) => entry.method === 'thread/status/changed')
    assert.deepEqual(started?.params.status, waiting('waitingOnApproval'))
    await s.desktop.respond(asked, { decision: 'accept' })
    assert.deepEqual(await outcome, { kind: 'result', value: 'allowed-once' })
    const done = await s.desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    assert.deepEqual(statuses(s.desktop, threadId).at(-1), idle)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})
