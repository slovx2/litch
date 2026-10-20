import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Daemon } from './fixtures/daemon.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'

// 提问等着人回答时换一条连接：照上游 codex（恢复线程时重放挂起的服务端请求），新连接 thread/resume
// 之后收到同一条 item/tool/requestUserInput（请求号、条目号都不变），答了原回合接着跑。
// isBlocking 照上游 0.163.0（core/src/tools/handlers/request_user_input.rs）：只有计划模式是 true。

const ask = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: '用哪个颜色？',
        header: '颜色',
        multiSelect: false,
        options: [
          { label: '蓝', description: '蓝色' },
          { label: '红', description: '红色' },
        ],
      },
    ],
  },
})

test('INPUT-RECONNECT-001：换连接恢复线程后重发没答的提问，同一个请求号和条目号，答了原回合接着跑；默认模式不标 blocking', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'input-reconnect-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start())
  try {
    const first = await daemon.connect('first')
    const { thread } = await first.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [ask('toolu_reconnect')])
    let answered = ''
    model.enqueue((request) => {
      answered = JSON.stringify(request.messages)
      return [{ type: 'text', text: 'RECONNECT_CONTINUED' }]
    })
    const { turn } = await first.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '先问我颜色' }],
    })
    const original = await first.serverRequest('item/tool/requestUserInput')
    assert.equal(original.params.isBlocking, false, '默认协作模式下不标 blocking')
    await first.disconnect()

    const second = await daemon.connect('second')
    await second.request('thread/resume', { threadId: thread.id })
    const replay = await second.serverRequest('item/tool/requestUserInput', 10_000)
    assert.equal(replay.id, original.id)
    assert.deepEqual(
      [replay.params.threadId, replay.params.turnId, replay.params.itemId],
      [original.params.threadId, original.params.turnId, original.params.itemId],
    )
    second.answer(replay, {
      answers: { [replay.params.questions[0].id]: { answers: ['蓝'] } },
    })
    const done = await second.completed(turn.id)
    assert.equal(done.status, 'completed')
    assert.match(answered, /蓝/)
    const read = await second.request('thread/read', { threadId: thread.id, includeTurns: true })
    const messages = read.thread.turns
      .at(-1)
      .items.filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.ok(messages.includes('RECONNECT_CONTINUED'), JSON.stringify(messages))
    await second.disconnect()
  } finally {
    await daemon.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('INPUT-RECONNECT-003：同一条连接再 thread/resume（客户端换了逻辑通道），挂着的提问照上游再发一次，答了原回合接着跑', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'input-resume-same-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start())
  try {
    const client = await daemon.connect('same')
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [ask('toolu_same_peer')])
    let answered = ''
    model.enqueue((request) => {
      answered = JSON.stringify(request.messages)
      return [{ type: 'text', text: 'SAME_PEER_CONTINUED' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '先问我颜色' }],
    })
    const original = await client.serverRequest('item/tool/requestUserInput')
    const before = client.trace.length
    await client.request('thread/resume', { threadId: thread.id })
    const deadline = Date.now() + 10_000
    const replays = () =>
      client.serverRequests.filter((request) => request.method === 'item/tool/requestUserInput')
    while (replays().length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(replays().length, 2, '恢复后同一条连接要再收到一次')
    const replay = replays()[1]
    assert.ok(replay)
    assert.equal(replay.id, original.id)
    assert.deepEqual(replay.params, original.params)
    // 先后照上游：恢复的应答在前，重发的请求在后
    const after = client.trace.slice(before)
    const responseAt = after.findIndex(
      (message) => message.method === undefined && message.result?.thread,
    )
    const replayAt = after.findIndex((message) => message === replay)
    assert.ok(
      responseAt >= 0 && replayAt > responseAt,
      JSON.stringify(after.map((m) => m.method ?? m.id)),
    )
    client.answer(replay, {
      answers: { [replay.params.questions[0].id]: { answers: ['红'] } },
    })
    const done = await client.completed(turn.id)
    assert.equal(done.status, 'completed')
    assert.match(answered, /红/)
    // 只重发一次，回答之后不再有新的
    assert.equal(replays().length, 2)
    await client.disconnect()
  } finally {
    await daemon.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('INPUT-RECONNECT-002：计划模式里的提问标 blocking', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'input-blocking-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start())
  try {
    const client = await daemon.connect('plan')
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [ask('toolu_plan_question')])
    model.enqueue(() => [{ type: 'text', text: 'PLAN_QUESTION_DONE' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '计划之前先问我' }],
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    const request = await client.serverRequest('item/tool/requestUserInput')
    assert.equal(request.params.isBlocking, true)
    client.answer(request, {
      answers: { [request.params.questions[0].id]: { answers: ['红'] } },
    })
    await client.completed(turn.id)
    await client.disconnect()
  } finally {
    await daemon.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
