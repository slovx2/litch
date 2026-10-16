import assert from 'node:assert/strict'
import test from 'node:test'
import { type Connection, openStage, type Stage } from './fixtures/in-process.mjs'

// 一个会话多个订阅连接（设计文档 03 第八节 A6）之三：不是“要一个决定”的那两类。
// 客户端执行的工具调用有副作用，只交给一条连接；子代理活动里新加的种类只发给声明过认识它的连接。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

const items = (connection: Connection, method: string, type: string) =>
  connection
    .notifications(method)
    .map((message) => message.params.item)
    .filter((item) => item.type === type)

test('MULTI-TOOL-001：客户端执行的工具调用只交给发起回合的那条连接；别的订阅连接看得到条目、收不到调用，后来订阅的也不补送', async () => {
  await withStage('multi-tool', async (stage) => {
    const first = await stage.connect('first')
    const second = await stage.connect('second')
    const { thread } = await first.request('thread/start', { cwd: stage.directory })
    await second.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    stage.script = async (_context, handlers) => {
      results.push(await handlers.onDynamicToolCall?.({ name: 'lookup' }, { key: 'a' }, 'call-1'))
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    }
    // 回合由后订阅的那条连接发起：调用给它，不是给最早订阅的那条。
    const { turn } = await second.request('turn/start', {
      threadId: thread.id,
      input: text('查一下'),
    })
    const call = await second.serverRequest('item/tool/call')
    const late = await stage.connect('late')
    await late.request('thread/resume', { threadId: thread.id })
    await settle()
    assert.equal(first.requests('item/tool/call').length, 0, '没发起回合的订阅连接收不到调用')
    assert.equal(late.requests('item/tool/call').length, 0, '送出去的调用不补送')
    assert.equal(items(first, 'item/started', 'dynamicToolCall').length, 1, '条目照常看得到')

    // 没拿着这条调用的连接替它回结果：不算。
    await first.answer(call, {
      success: false,
      contentItems: [{ type: 'inputText', text: '抢答' }],
    })
    await settle()
    assert.deepEqual(results, [])

    await second.answer(call, { success: true, contentItems: [{ type: 'inputText', text: '42' }] })
    for (const connection of [first, second, late])
      assert.equal((await connection.completed(turn.id)).status, 'completed')
    assert.deepEqual(results, [
      { success: true, contentItems: [{ type: 'inputText', text: '42' }] },
    ])
    for (const connection of [first, second, late])
      assert.equal(
        items(connection, 'item/completed', 'dynamicToolCall')[0]?.status,
        'completed',
        `${connection.name} 看到调用完成`,
      )
    assert.equal(second.notifications('serverRequest/resolved').length, 1)
    for (const connection of [first, late])
      assert.equal(
        connection.notifications('serverRequest/resolved').length,
        0,
        `${connection.name} 没见过这个请求号，不被告知`,
      )
  })
})

test('MULTI-TOOL-002：拿着工具调用的连接断开，调用按失败结束，不改交给别的订阅连接', async () => {
  await withStage('multi-tool-drop', async (stage) => {
    const first = await stage.connect('first')
    const second = await stage.connect('second')
    const { thread } = await first.request('thread/start', { cwd: stage.directory })
    await second.request('thread/resume', { threadId: thread.id })
    const failures: string[] = []
    stage.script = async (_context, handlers) => {
      await handlers
        .onDynamicToolCall?.({ name: 'lookup' }, { key: 'a' }, 'call-1')
        ?.catch((error) => failures.push(String(error)))
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    }
    const { turn } = await first.request('turn/start', { threadId: thread.id, input: text('查') })
    await first.serverRequest('item/tool/call')
    first.disconnect()
    assert.equal((await second.completed(turn.id)).status, 'completed')
    assert.equal(failures.length, 1)
    assert.match(failures[0] as string, /交互连接已关闭/)
    assert.equal(second.requests('item/tool/call').length, 0)
    assert.equal(items(second, 'item/completed', 'dynamicToolCall')[0]?.status, 'failed')
  })
})

test('MULTI-TOOL-003：子代理活动的 started、completed 只发给声明过认识它的连接；子线程和别的通知两边都收到', async () => {
  await withStage('multi-subagent', async (stage) => {
    const plain = await stage.connect('plain')
    const modern = await stage.connect('modern', { subAgentActivityCompleted: true })
    const { thread } = await plain.request('thread/start', { cwd: stage.directory })
    await modern.request('thread/resume', { threadId: thread.id })
    await settle()
    const mark = { plain: plain.trace.length, modern: modern.trace.length }
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'task-1',
        toolName: 'Task',
        input: { description: '查一查', prompt: 'investigate' },
      })
      await settle()
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: 'task-1',
        content: [
          '查完了',
          "agentId: deadbeefcafef00d (use SendMessage with to: 'deadbeefcafef00d' to continue this agent)",
          '<usage>total_tokens: 42',
          'tool_uses: 1',
          'duration_ms: 10</usage>',
        ].join('\n'),
      })
      await handlers.onEvent({ type: 'text_delta', delta: '汇总' })
      await handlers.onEvent({ type: 'completed', success: true, result: '汇总' })
    }
    const { turn } = await plain.request('turn/start', {
      threadId: thread.id,
      input: text('派一个子代理'),
    })
    for (const connection of [plain, modern])
      assert.equal((await connection.completed(turn.id)).status, 'completed')
    await settle()

    const kinds = (connection: Connection) =>
      items(connection, 'item/completed', 'subAgentActivity').map((item) => item.kind)
    assert.deepEqual(kinds(modern), ['started', 'completed'])
    assert.deepEqual(kinds(plain), [], '没声明的连接（官方桌面端）收不到它不认识的种类')

    // 除了这几条活动，两边收到的完全一样：子线程的开始、回合、父线程的等待条目。
    const rest = (connection: Connection, from: number) =>
      connection.trace
        .slice(from)
        .filter((message) => message.method && message.id === undefined)
        .filter((message) => message.params?.item?.type !== 'subAgentActivity')
    const seen = rest(plain, mark.plain)
    assert.deepEqual(rest(modern, mark.modern), seen)
    const child = seen.find(
      (message) =>
        message.method === 'thread/started' && message.params.thread.threadSource === 'subagent',
    )
    assert.ok(child, '子线程的开始两边都收到')
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'turn/completed' && message.params.threadId === child.params.thread.id,
      ),
      '子线程的回合两边都收到',
    )
  })
})
