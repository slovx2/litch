import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('EVENTS-002：流式事件与历史一致，重启和归档后累计用量不丢失', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-events-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    for (let index = 0; index < 3; index++) {
      if (index === 1) {
        await client.close()
        client = await ProtocolClient.start(home, url)
        await client.request('thread/resume', { threadId: thread.id })
      }
      if (index === 2) {
        await client.request('thread/archive', { threadId: thread.id })
        await client.request('thread/unarchive', { threadId: thread.id })
        await client.request('thread/resume', { threadId: thread.id })
      }
      if (index) {
        await client.notification(
          'thread/tokenUsage/updated',
          (params) =>
            params.threadId === thread.id && params.tokenUsage.total.totalTokens === 120 * index,
        )
      }
      assert.equal(llm.requests.length, index, '恢复及归档不能请求模型')
      llm.enqueue((request) => {
        if (index) assert.match(JSON.stringify(request.messages), /EVENT_INPUT_0/)
        return [
          { type: 'text', text: 'EVENT_FIRST_' + index },
          { type: 'text', text: '_LAST' },
        ]
      })
      const start = client.trace.length
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        clientUserMessageId: 'events-' + index,
        input: [{ type: 'text', text: 'EVENT_INPUT_' + index }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const events = client.trace
        .slice(start)
        .filter(
          (message) =>
            message.method &&
            message.direction !== 'client' &&
            message.params.threadId === thread.id,
        )
      const methods = events.map((message) => message.method)
      assert.equal(methods.filter((method) => method === 'turn/started').length, 1)
      assert.equal(methods.filter((method) => method === 'turn/completed').length, 1)
      const first = methods.indexOf('turn/started')
      const last = methods.indexOf('turn/completed')
      const active = events.findIndex(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'active',
      )
      const idle = events.findIndex(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'idle',
      )
      assert.ok(active >= 0 && idle > active && idle <= last)
      const starts = new Set<string>()
      const ends = new Set<string>()
      let streamed = ''
      for (const [position, event] of events.entries()) {
        if (event.method.startsWith('item/')) assert.ok(position > first && position < last)
        if (event.method === 'item/started') {
          assert.equal(starts.has(event.params.item.id), false)
          starts.add(event.params.item.id)
        }
        if (event.method === 'item/agentMessage/delta') streamed += event.params.delta
        if (event.method === 'item/completed') {
          assert.ok(starts.has(event.params.item.id), '不能先完成后开始')
          assert.equal(ends.has(event.params.item.id), false, '一个 item 只能完成一次')
          ends.add(event.params.item.id)
        }
      }
      assert.deepEqual(starts, ends, '成功终态不能遗留活动 item')
      assert.equal(streamed, 'EVENT_FIRST_' + index + '_LAST')
      const usage = events.filter((event) => event.method === 'thread/tokenUsage/updated').at(-1)
      assert.ok(usage)
      assert.equal(usage.params.turnId, turn.id)
      assert.equal(usage.params.tokenUsage.last.totalTokens, 120)
      assert.equal(
        usage.params.tokenUsage.total.totalTokens,
        120 * (index + 1),
        '重启和归档不能清零累计用量',
      )
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      const stored = history.thread.turns.find((entry: any) => entry.id === turn.id)
      assert.equal(stored.status, 'completed')
      assert.equal(
        stored.items
          .filter((item: any) => item.type === 'agentMessage')
          .map((item: any) => item.text)
          .join(''),
        streamed,
      )
    }
    const { thread: fork } = await client.request('thread/fork', { threadId: thread.id })
    await client.close()
    client = await ProtocolClient.start(home, url)
    await client.request('thread/resume', { threadId: fork.id })
    await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.threadId === fork.id && params.tokenUsage.total.totalTokens === 360,
    )
    llm.enqueue(() => [{ type: 'text', text: 'FORK_EVENTS' }])
    const { turn: forkTurn } = await client.request('turn/start', {
      threadId: fork.id,
      input: [{ type: 'text', text: '分支独立累计' }],
    })
    assert.equal((await client.completed(forkTurn.id)).status, 'completed')
    // 请求一结束就先报一次占用（累计还没变），回合结束时再把回合的累计加进去
    const usage = await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.turnId === forkTurn.id && params.tokenUsage.total.totalTokens !== 360,
    )
    assert.equal(usage.tokenUsage.total.totalTokens, 480)
    await client.request('thread/resume', { threadId: thread.id })
    await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.threadId === thread.id && params.tokenUsage.total.totalTokens === 360,
    )
    assert.equal(llm.requests.length, 4)
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('EVENTS-003：一个回合里多次工具调用，占用是最近一次请求的、不累加；每次请求结束就报，带上下文窗口', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-usage-'))
  const llm = new MockLLM()
  const url = await llm.start()
  const client = await ProtocolClient.start(home, url)
  try {
    // 三次请求，每次的用量都不一样：上下文一次比一次多，缓存读一次比一次多
    const usages = [
      { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 30 },
      { input_tokens: 60, cache_read_input_tokens: 1030, output_tokens: 25 },
      { input_tokens: 50, cache_read_input_tokens: 1115, output_tokens: 20 },
    ]
    const contexts = usages.map(
      (usage) => usage.input_tokens + usage.cache_read_input_tokens + usage.output_tokens,
    )
    for (const [index, usage] of usages.entries())
      llm.enqueue(() => ({
        content:
          index < 2
            ? [
                {
                  type: 'tool_use',
                  id: `usage_bash_${index}`,
                  name: 'Bash',
                  input: { command: `echo USAGE_${index}` },
                },
              ]
            : [{ type: 'text', text: 'USAGE_DONE' }],
        usage,
      }))
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    const start = client.trace.length
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '连着跑两条命令' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    llm.assertConsumed()
    const events = client.trace.slice(start).filter((message) => message.method)
    const done = events.findIndex((message) => message.method === 'turn/completed')
    const updates = events
      .map((message, position) => ({ message, position }))
      .filter(
        ({ message }) =>
          message.method === 'thread/tokenUsage/updated' && message.params.threadId === thread.id,
      )
    // 每次请求结束都报过一次，回合结束前就到了，报的是那次请求的上下文
    const seen = updates
      .filter(({ position }) => position < done)
      .map(({ message }) => message.params.tokenUsage.last.totalTokens)
    assert.deepEqual([...new Set(seen)], contexts)
    const final = updates.at(-1)?.message.params.tokenUsage
    assert.ok(final)
    assert.equal(final.last.totalTokens, contexts[2], '占用不能把各次请求累加起来')
    assert.equal(final.last.cachedInputTokens, usages[2]?.cache_read_input_tokens)
    assert.equal(
      final.total.totalTokens,
      contexts.reduce((sum, value) => sum + value, 0),
      '累计是整个回合各次请求之和',
    )
    assert.ok(
      typeof final.modelContextWindow === 'number' && final.modelContextWindow > 0,
      '要带上下文窗口',
    )
    // 恢复时回放的也带着窗口
    const before = client.trace.length
    await client.request('thread/resume', { threadId: thread.id })
    let replay: any
    for (let tries = 0; tries < 250 && !replay; tries++) {
      replay = client.trace
        .slice(before)
        .find(
          (message) =>
            message.method === 'thread/tokenUsage/updated' && message.params.threadId === thread.id,
        )
      if (!replay) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(replay, '恢复时要回放用量')
    assert.deepEqual(replay.params.tokenUsage, final)
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
