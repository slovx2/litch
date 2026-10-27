import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// 等 CLI 把这几句都读进自己的队列：它排进队列时在会话记录里记一条 queue-operation enqueue。
// turn/steer 的回执只说明话已写进 CLI 的标准输入，CLI 读进队列还要一会儿；那一刻之前模型应答已经收尾的话，
// 这句留到下一轮请求（仍在同一回合里）。要几句落进同一次请求，先等到它们都排进队列再放行应答
async function waitQueued(home: string, texts: string[]): Promise<void> {
  const projects = join(home, 'claude', 'projects')
  const deadline = Date.now() + 30_000
  for (;;) {
    const queued = new Set<string>()
    for (const project of await readdir(projects).catch(() => [] as string[]))
      for (const name of await readdir(join(projects, project))) {
        if (!name.endsWith('.jsonl')) continue
        // 最后一行可能还没写完，只看整行
        const lines = (await readFile(join(projects, project, name), 'utf8'))
          .split('\n')
          .slice(0, -1)
        for (const line of lines) {
          const entry = JSON.parse(line)
          if (entry.type === 'queue-operation' && entry.operation === 'enqueue')
            queued.add(entry.content)
        }
      }
    if (texts.every((text) => queued.has(text))) return
    assert.ok(Date.now() < deadline, `CLI 没有把这几句排进队列：${texts.join('、')}`)
    await delay(20)
  }
}

test('SUBMIT-003：启动窗口连续追加输入不能丢失或额外创建回合', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-early-steer-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let requests = 0
    const response = (request: Record<string, any>) => {
      requests++
      assert.ok(requests <= 3, '不能无限续跑')
      const text = JSON.stringify(request.messages)
      if (!text.includes('EARLY_SECOND')) model.enqueue(response)
      else {
        assert.equal(text.split('EARLY_FIRST').length - 1, 1)
        assert.equal(text.split('EARLY_SECOND').length - 1, 1)
      }
      return [
        { type: 'text', text: text.includes('EARLY_SECOND') ? 'ALL_INPUTS_CONSUMED' : 'NEXT' },
      ]
    }
    model.enqueue(response)
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'ORIGINAL' }],
    })
    for (const [index, text] of ['EARLY_FIRST', 'EARLY_SECOND'].entries()) {
      await client.request('turn/steer', {
        threadId: thread.id,
        expectedTurnId: turn.id,
        clientUserMessageId: 'early-' + index,
        input: [{ type: 'text', text }],
      })
    }
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(history.thread.turns.length, 1)
    assert.equal(
      history.thread.turns[0].items.filter((item: any) => item.type === 'agentMessage').at(-1).text,
      'ALL_INPUTS_CONSUMED',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('EVENTS-004：中断等待工具的回合必须终结条目，迟到答案不能恢复执行', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-cancel-tool-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const entered = gate(),
    release = gate(),
    answered = gate()
  try {
    client.onTool = async () => {
      entered.resolve()
      await release.promise
      answered.resolve()
      return { success: true, contentItems: [{ type: 'inputText', text: 'LATE_TOOL_RESULT' }] }
    }
    model.enqueue((request) => [
      {
        type: 'tool_use',
        id: 'toolu_cancel',
        name: request.tools.find((entry: any) =>
          entry.name.startsWith('mcp__codex_harness_adapter__'),
        ).name,
        input: {},
      },
    ])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'wait_fixture',
          description: '等待测试信号',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待工具时取消' }],
    })
    await entered.promise
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal((await client.completed(turn.id)).status, 'interrupted')
    release.resolve()
    await answered.promise
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const tools = history.thread.turns[0].items.filter(
      (item: any) => item.type === 'dynamicToolCall',
    )
    assert.equal(tools.length, 1)
    assert.equal(tools[0].status, 'failed', '不能遗留永久等待的工具条目')
    assert.notEqual(tools[0].success, true)
    const done = client.trace.findIndex((event) => event.method === 'turn/completed')
    const itemDone = client.trace.findIndex(
      (event) => event.method === 'item/completed' && event.params.item.id === tools[0].id,
    )
    assert.ok(itemDone >= 0 && itemDone < done, '工具终态必须先于回合终态')
    assert.equal(model.requests.length, 1)
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBMIT-003：真实 SDK 追加指令、并发提交、重复请求与冲突保持同一回合', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-steer-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const entered = gate()
  const release = gate()
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    model.enqueue(async () => {
      entered.resolve()
      await release.promise
      return [{ type: 'text', text: 'BEFORE_STEER' }]
    })
    model.enqueue((request) => {
      const text = JSON.stringify(request.messages)
      assert.match(text, /ORIGINAL_INPUT/)
      assert.equal(
        text.split('STEER_INPUT').length - 1,
        1,
        '追加指令恰好进模型一次：不丢、重复请求不重复输入',
      )
      assert.equal(text.split('CONCURRENT_INPUT').length - 1, 1)
      return [{ type: 'text', text: 'AFTER_STEER' }]
    })
    const params = {
      threadId: thread.id,
      clientUserMessageId: 'original',
      input: [{ type: 'text', text: 'ORIGINAL_INPUT' }],
    }
    const { turn } = await client.request('turn/start', params)
    await entered.promise
    assert.equal((await client.request('turn/start', params)).turn.id, turn.id)
    // 回合进行中另一条 turn/start 和上游 codex 一样并进这个回合（start_or_steer），回执是同一个回合号
    const concurrent = await client.request('turn/start', {
      ...params,
      clientUserMessageId: 'concurrent',
      input: [{ type: 'text', text: 'CONCURRENT_INPUT' }],
    })
    assert.equal(concurrent.turn.id, turn.id)
    const steer = {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'steer-message',
      input: [{ type: 'text', text: 'STEER_INPUT' }],
    }
    const steered = await Promise.all([
      client.request('turn/steer', steer),
      client.request('turn/steer', steer),
    ])
    assert.ok(steered.every((result) => result.turnId === turn.id))
    await client.raw(
      'turn/steer',
      { ...steer, input: [{ type: 'text', text: 'CONFLICT' }] },
      -32009,
    )
    // 两句都排进 CLI 的队列再放行第一次应答，它们才一定并进第二次请求（不等的话慢机器上插话可能晚于应答收尾，拆成两轮）
    await waitQueued(home, ['CONCURRENT_INPUT', 'STEER_INPUT'])
    release.resolve()
    // 第二条请求里的断言不过时假模型回 400，回合只看得到 failed：把假模型记下的原因带出来
    const done = await client.completed(turn.id)
    assert.equal(
      done.status,
      'completed',
      JSON.stringify({
        error: done.error,
        unexpected: model.unexpected,
        requests: model.requests.length,
      }),
    )
    assert.equal(model.requests.length, 2, '追加指令必须真正进入 SDK 模型请求')
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(history.thread.turns.length, 1)
    const items = history.thread.turns[0].items
    assert.equal(items.filter((item: any) => item.clientId === 'steer-message').length, 1)
    assert.equal(items.filter((item: any) => item.clientId === 'concurrent').length, 1)
    assert.equal(
      items.filter((item: any) => item.type === 'agentMessage').at(-1).text,
      'AFTER_STEER',
    )
    assert.equal(client.trace.filter((event) => event.method === 'turn/completed').length, 1)
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.equal((await client.request('turn/steer', steer)).turnId, turn.id)
    assert.equal(model.requests.length, 2, '重启后确认过的追加指令不可重放')
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('EVENTS-004：真实 SDK 中断校验线程与回合身份，终态唯一且可继续恢复', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-interrupt-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const entered = gate()
  const release = gate()
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const { thread: unrelated } = await client.request('thread/start', { cwd: home })
    model.enqueue(async () => {
      entered.resolve()
      await release.promise
      return [{ type: 'text', text: 'LATE_RESULT' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'INTERRUPTED_INPUT' }],
    })
    await entered.promise
    await client.raw('turn/interrupt', { threadId: unrelated.id, turnId: turn.id }, -32602)
    await client.raw('turn/interrupt', { threadId: thread.id, turnId: 'wrong-turn' }, -32009)
    const before = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(before.thread.turns[0].status, 'inProgress', '错误身份不能取消活动回合')
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal((await client.completed(turn.id)).status, 'interrupted')
    release.resolve()
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal(client.trace.filter((event) => event.method === 'turn/completed').length, 1)
    const after = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(after.thread.status.type, 'idle')
    assert.equal(after.thread.turns[0].status, 'interrupted')
    assert.ok(after.thread.turns[0].items.every((item: any) => item.status !== 'inProgress'))
    await client.close()
    client = await ProtocolClient.start(home, url)
    await client.request('thread/resume', { threadId: thread.id })
    model.enqueue(() => [{ type: 'text', text: 'AFTER_INTERRUPT' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续取消后的会话' }],
    })
    const continued = await client.completed(next.turn.id)
    assert.equal(continued.status, 'completed', JSON.stringify(continued))
    const restored = await client.request('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
    assert.deepEqual(
      restored.thread.turns.map((entry: any) => entry.status),
      ['interrupted', 'completed'],
    )
    assert.equal(model.requests.length, 2)
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
