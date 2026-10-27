import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { type Connection, openStage, type Stage } from './fixtures/in-process.mjs'

// 客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）的执行方怎么挑：
// litch_ 开头的命名空间只交给握手时声明了它的连接——发起回合的那条优先，其次最早订阅、声明了的那条；
// 都没有就当场回 noExecutor 失败，不等人订阅、不交给没声明的连接。别的命名空间照旧（MULTI-TOOL-*）。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const LITCH = { litchExtensions: ['clientTools'], litchClientTools: { namespaces: ['litch_echo'] } }
/** 声明了扩展、但只能执行别的命名空间 */
const OTHER = {
  litchExtensions: ['clientTools'],
  litchClientTools: { namespaces: ['litch_browser'] },
}
/** 列了命名空间却没声明扩展：不算 */
const UNDECLARED = { litchClientTools: { namespaces: ['litch_echo'] } }
const OK = { success: true, contentItems: [{ type: 'inputText', text: '42' }] }

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

const toolItems = (connection: Connection, method: string) =>
  connection
    .notifications(method)
    .map((message) => message.params.item)
    .filter((item) => item.type === 'dynamicToolCall')

/** 回合里调一次 namespace.echo，结果（或抛出的错误）记进 results */
function scriptCall(stage: Stage, namespace: string, results: unknown[]): void {
  stage.script = async (_context, handlers) => {
    try {
      results.push(await handlers.onDynamicToolCall?.({ name: 'echo', namespace }, { a: 1 }, 'c-1'))
    } catch (error) {
      results.push(String(error))
    }
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
}

test('CLIENT-TOOLS-001：发起回合的连接声明了命名空间，调用交给它；别的声明了的订阅连接收不到', async () => {
  await withStage('ct-starter', async (stage) => {
    const first = await stage.connect('first', LITCH)
    const second = await stage.connect('second', LITCH)
    const { thread } = await first.request('thread/start', { cwd: stage.directory })
    await second.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, 'litch_echo', results)
    const { turn } = await second.request('turn/start', { threadId: thread.id, input: text('调') })
    const call = await second.serverRequest('item/tool/call')
    assert.equal(call.params.namespace, 'litch_echo')
    assert.equal('itemId' in call.params, false)
    await second.answer(call, OK)
    assert.equal((await second.completed(turn.id)).status, 'completed')
    assert.equal(first.requests('item/tool/call').length, 0)
    assert.deepEqual(results, [OK])
  })
})

test('CLIENT-TOOLS-002：发起回合的连接没声明（官方桌面端），交给最早订阅、声明了的连接', async () => {
  await withStage('ct-earliest', async (stage) => {
    const desktop = await stage.connect('desktop')
    const other = await stage.connect('other', OTHER)
    const litch = await stage.connect('litch', LITCH)
    const late = await stage.connect('late', LITCH)
    const { thread } = await desktop.request('thread/start', { cwd: stage.directory })
    for (const connection of [other, litch, late])
      await connection.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, 'litch_echo', results)
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    const call = await litch.serverRequest('item/tool/call')
    await litch.answer(call, OK)
    assert.equal((await desktop.completed(turn.id)).status, 'completed')
    for (const connection of [desktop, other, late])
      assert.equal(connection.requests('item/tool/call').length, 0, connection.name)
    assert.deepEqual(results, [OK])
  })
})

test('CLIENT-TOOLS-003：没有声明了的连接时当场回 noExecutor，谁都收不到调用，条目记成失败', async () => {
  await withStage('ct-none', async (stage) => {
    const desktop = await stage.connect('desktop')
    const loose = await stage.connect('loose', UNDECLARED)
    const other = await stage.connect('other', OTHER)
    const { thread } = await desktop.request('thread/start', { cwd: stage.directory })
    for (const connection of [loose, other])
      await connection.request('thread/resume', { threadId: thread.id })
    const results: any[] = []
    scriptCall(stage, 'litch_echo', results)
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    assert.equal((await desktop.completed(turn.id)).status, 'completed')
    await settle()
    for (const connection of [desktop, loose, other])
      assert.equal(connection.requests('item/tool/call').length, 0, connection.name)
    assert.equal(results.length, 1)
    assert.equal(results[0].success, false)
    assert.match(results[0].contentItems[0].text, /^\[litch:noExecutor\] /)
    const done = toolItems(desktop, 'item/completed')[0]
    assert.equal(done?.status, 'failed')
    assert.equal(done?.success, false)
  })
})

test('CLIENT-TOOLS-004：会话没人订阅也不留着等：发起回合的连接退订了又没别人，当场失败', async () => {
  await withStage('ct-unwatched', async (stage) => {
    const litch = await stage.connect('litch', LITCH)
    const desktop = await stage.connect('desktop')
    const { thread } = await desktop.request('thread/start', { cwd: stage.directory })
    await desktop.request('thread/unsubscribe', { threadId: thread.id })
    const results: any[] = []
    scriptCall(stage, 'litch_echo', results)
    // 回合由没声明的连接发起，声明了的 litch 没订阅：不交给它，也不等它
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    await desktop.completed(turn.id)
    await settle()
    assert.equal(litch.requests('item/tool/call').length, 0)
    assert.equal(desktop.requests('item/tool/call').length, 0)
    assert.match(results[0]?.contentItems?.[0]?.text ?? '', /^\[litch:noExecutor\] /)
  })
})

test('CLIENT-TOOLS-005：挑中的执行方断开，调用按失败结束，不改交给别的声明了的连接', async () => {
  await withStage('ct-drop', async (stage) => {
    const desktop = await stage.connect('desktop')
    const litch = await stage.connect('litch', LITCH)
    const spare = await stage.connect('spare', LITCH)
    const { thread } = await desktop.request('thread/start', { cwd: stage.directory })
    for (const connection of [litch, spare])
      await connection.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, 'litch_echo', results)
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    await litch.serverRequest('item/tool/call')
    litch.disconnect()
    assert.equal((await desktop.completed(turn.id)).status, 'completed')
    assert.equal(spare.requests('item/tool/call').length, 0)
    assert.match(String(results[0]), /交互连接已关闭/)
  })
})

test('CLIENT-TOOLS-006：别的命名空间照旧：交给发起回合的连接，不看它声明了什么', async () => {
  await withStage('ct-other-namespace', async (stage) => {
    const desktop = await stage.connect('desktop')
    const litch = await stage.connect('litch', LITCH)
    const { thread } = await litch.request('thread/start', { cwd: stage.directory })
    await desktop.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, 'files', results)
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    const call = await desktop.serverRequest('item/tool/call')
    await desktop.answer(call, OK)
    assert.equal((await desktop.completed(turn.id)).status, 'completed')
    assert.equal(litch.requests('item/tool/call').length, 0)
    assert.deepEqual(results, [OK])
  })
})

test('CLIENT-TOOLS-007：litch_sessions 照同一套规矩：设备进程替上游连接声明了的收得到，只声明了浏览器的收不到', async () => {
  await withStage('ct-sessions', async (stage) => {
    const sessions = CLIENT_TOOL_NAMESPACE.sessions
    // 设备进程转给入口的握手：官方桌面端那条只多了 litch_sessions，Litch 桌面端那条是浏览器加 litch_sessions
    const official = await stage.connect('official', {
      litchExtensions: ['clientTools'],
      litchClientTools: { namespaces: [sessions] },
    })
    const browserOnly = await stage.connect('browser-only', OTHER)
    const { thread } = await browserOnly.request('thread/start', { cwd: stage.directory })
    await official.request('thread/resume', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, sessions, results)
    // 回合由只声明了浏览器的连接发起：它不能执行 litch_sessions，交给订阅着、声明了的那条
    const { turn } = await browserOnly.request('turn/start', {
      threadId: thread.id,
      input: text('调'),
    })
    const call = await official.serverRequest('item/tool/call')
    assert.equal(call.params.namespace, sessions)
    await official.answer(call, OK)
    assert.equal((await browserOnly.completed(turn.id)).status, 'completed')
    assert.equal(browserOnly.requests('item/tool/call').length, 0)
    assert.deepEqual(results, [OK])
  })
})

test('CLIENT-TOOLS-008：发起者、订阅者都挑不出来时交给把命名空间列在 anyThread 里的连接（设备进程的），只声明没列的不给', async () => {
  await withStage('ct-any-thread', async (stage) => {
    const sessions = CLIENT_TOOL_NAMESPACE.sessions
    // 设备进程自己的连接：没订阅这个会话，litch_sessions 不看会话
    const device = await stage.connect('device', {
      litchExtensions: ['clientTools'],
      litchClientTools: { namespaces: [sessions], anyThread: [sessions] },
    })
    // 只声明、没列 anyThread 的连接（客户端执行的工具）：没订阅就不交给它
    const listed = await stage.connect('listed', {
      litchExtensions: ['clientTools'],
      litchClientTools: { namespaces: [sessions, 'litch_echo'] },
    })
    const desktop = await stage.connect('desktop')
    const { thread } = await desktop.request('thread/start', { cwd: stage.directory })
    await desktop.request('thread/unsubscribe', { threadId: thread.id })
    const results: unknown[] = []
    scriptCall(stage, sessions, results)
    const { turn } = await desktop.request('turn/start', { threadId: thread.id, input: text('调') })
    const call = await device.serverRequest('item/tool/call')
    await device.answer(call, OK)
    await desktop.completed(turn.id)
    assert.deepEqual(results, [OK])
    assert.equal(listed.requests('item/tool/call').length, 0)
  })
})
