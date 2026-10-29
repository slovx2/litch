import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeSessionSource } from '../src/native-sessions.mjs'
import type { ClaudeRuntime } from '../src/types.mjs'
import { Connection, openStage, type Stage } from './fixtures/in-process.mjs'

const METHOD = 'litch/internal/power/activity'
const OBSERVER = 'litch-power-observer'
const COMMAND = 'item/commandExecution/requestApproval'
const input = [{ type: 'text', text: '模拟任务' }]
const level = (tasks: Array<Record<string, unknown>>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
})

function background(stage: Stage, threadId: string, tasks: Array<Record<string, unknown>>): void {
  const handler = stage.session().onBackgroundTaskMessage
  assert.ok(handler)
  handler(threadId, level(tasks))
}

async function withoutDatabase<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
  const db = (stage.store as unknown as { db: { prepare: (...args: unknown[]) => unknown } }).db
  const original = db.prepare
  db.prepare = () => {
    throw new Error('电源观察不应读取数据库')
  }
  try {
    return await action()
  } finally {
    db.prepare = original
  }
}

test('POWER-CLAUDE-001：只认精确观察握手，普通连接和未握手连接保持未知方法错误', async () => {
  const stage = await openStage('power-gate', { native: null })
  try {
    const uninitialized = new Connection(stage.server, OBSERVER)
    const ordinary = await stage.connect('ordinary', { litchExtensions: ['devicePower'] })
    const near = await stage.connect(`${OBSERVER}-other`)
    for (const peer of [uninitialized, ordinary, near]) {
      const reply = await peer.raw(METHOD)
      assert.deepEqual(reply.error, { code: -32601, message: `method not implemented: ${METHOD}` })
    }
    assert.equal(
      (await ordinary.raw('initialize', { clientInfo: { name: OBSERVER } })).error.code,
      -32600,
    )
    const observer = await stage.connect(OBSERVER)
    assert.deepEqual(await observer.request(METHOD), { threads: [] })
    assert.equal((await observer.raw('thread/start', { cwd: stage.directory })).error.code, -32601)
    for (const threadIds of [null, 'one', [1], [''], new Array(16385).fill('a')])
      assert.equal((await observer.raw(METHOD, { threadIds })).error.code, -32602)
    observer.disconnect()
    assert.equal((await observer.raw(METHOD)).error.code, -32601)
  } finally {
    await stage.dispose()
  }
})

test('POWER-CLAUDE-002：观察握手与查询不读数据库/原生历史，不探测模型或触发普通连接收尾', async (t) => {
  let nativeCalls = 0
  const forbidden = () => {
    nativeCalls++
    throw new Error('观察连接不应查询原生历史')
  }
  const native: NativeSessionSource = {
    list: forbidden,
    info: forbidden,
    messages: forbidden,
    lineage: forbidden,
    desktop: forbidden,
    record: forbidden,
  }
  const stage = await openStage('power-readonly', { native })
  const runtime = (stage.server as unknown as { runtime: ClaudeRuntime }).runtime
  let models = 0
  let closed = 0
  runtime.supportedModels = async () => {
    models++
    throw new Error('不应探测 CLI 模型目录')
  }
  runtime.closeIdleSessions = async () => {
    closed++
  }
  runtime.closeIdleMcp = async () => {
    closed++
  }
  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    const observer = new Connection(stage.server, 'internal-transport')
    await withoutDatabase(stage, async () => {
      const handshake = await observer.request('initialize', {
        clientInfo: { name: OBSERVER, version: 'test' },
      })
      assert.deepEqual(Object.keys(handshake).sort(), [
        'codexHome',
        'platformFamily',
        'platformOs',
        'userAgent',
      ])
      assert.deepEqual(await observer.request(METHOD), { threads: [] })
      assert.deepEqual(await observer.request(METHOD, { threadIds: ['unknown', 'unknown'] }), {
        threads: [{ threadId: 'unknown', active: false, background: false }],
      })
      assert.deepEqual(await observer.request(METHOD, { threadIds: [] }), { threads: [] })
      t.mock.timers.tick(31_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      observer.disconnect()
    })
    assert.equal(nativeCalls, 0)
    assert.equal(models, 0)
    assert.equal(closed, 0)
    assert.deepEqual(observer.notifications(), [])
    assert.deepEqual(observer.requests(), [])
  } finally {
    t.mock.timers.reset()
    await stage.dispose()
  }
})

test('POWER-CLAUDE-003：等待确认仍活动，后台跨越回合结束，定向查询不发现别的新增工作', async () => {
  const stage = await openStage('power-work', { native: null })
  let releaseExternal!: () => void
  const externalGate = new Promise<void>((resolve) => {
    releaseExternal = resolve
  })
  try {
    const owner = await stage.connect('owner')
    const external = await stage.connect('external')
    const { thread } = await owner.request('thread/start', { cwd: stage.directory })
    const idle = (await owner.request('thread/start', { cwd: stage.directory })).thread
    stage.script = async (_context, handlers) => {
      const call = { toolUseId: 'permission', toolName: 'Bash', input: { command: 'echo fake' } }
      await handlers.onEvent({ type: 'tool_use', ...call })
      await handlers.onPermissionRequest({
        type: 'permission_request',
        requestId: 'permission',
        ...call,
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: call.toolUseId,
        content: 'done',
        isError: false,
      })
      await handlers.onEvent({ type: 'completed', success: true })
    }
    const { turn } = await owner.request('turn/start', { threadId: thread.id, input })
    const approval = await owner.serverRequest(COMMAND)
    // 观察连接在工作开始后才建立，模拟设备服务的恢复。
    const observer = await stage.connect(OBSERVER)
    assert.deepEqual(await withoutDatabase(stage, () => observer.request(METHOD)), {
      threads: [{ threadId: thread.id, active: true, background: false }],
    })
    background(stage, thread.id, [
      { task_id: 'shell', task_type: 'local_bash', description: 'secret command' },
    ])
    stage.script = async (_context, handlers) => {
      await externalGate
      await handlers.onEvent({ type: 'completed', success: true })
    }
    const other = (await external.request('thread/start', { cwd: stage.directory })).thread
    const otherTurn = (await external.request('turn/start', { threadId: other.id, input })).turn
    assert.deepEqual(
      await withoutDatabase(stage, () =>
        observer.request(METHOD, { threadIds: [thread.id, idle.id] }),
      ),
      {
        threads: [
          { threadId: thread.id, active: true, background: true },
          { threadId: idle.id, active: false, background: false },
        ],
      },
    )
    await owner.answer(approval, { decision: 'accept' })
    assert.equal((await owner.completed(turn.id)).status, 'completed')
    releaseExternal()
    await external.completed(otherTurn.id)
    assert.deepEqual(await withoutDatabase(stage, () => observer.request(METHOD)), {
      threads: [{ threadId: thread.id, active: false, background: true }],
    })
    background(stage, thread.id, [])
    assert.deepEqual(await observer.request(METHOD), { threads: [] })
    assert.deepEqual(await observer.request(METHOD, { threadIds: [thread.id] }), {
      threads: [{ threadId: thread.id, active: false, background: false }],
    })
    assert.deepEqual(observer.notifications(), [])
    assert.deepEqual(observer.requests(), [])
  } finally {
    releaseExternal()
    await stage.dispose()
  }
})

test('POWER-CLAUDE-004：CLI 后台命令回执早于任务集合时也能恢复，进程退出后移除', async () => {
  const stage = await openStage('power-shell', { native: null })
  try {
    const owner = await stage.connect('owner')
    const { thread } = await owner.request('thread/start', { cwd: stage.directory })
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'shell',
        toolName: 'Bash',
        input: { command: 'fake-background' },
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: 'shell',
        backgroundTaskId: 'background-1',
        content: 'backgrounded',
        isError: false,
      })
      await handlers.onEvent({ type: 'completed', success: true })
    }
    const { turn } = await owner.request('turn/start', { threadId: thread.id, input })
    await owner.completed(turn.id)
    const observer = await stage.connect(OBSERVER)
    assert.deepEqual(await withoutDatabase(stage, () => observer.request(METHOD)), {
      threads: [{ threadId: thread.id, active: false, background: true }],
    })
    stage.session().onSessionClosed(thread.id, 'test')
    assert.deepEqual(await observer.request(METHOD), { threads: [] })
  } finally {
    await stage.dispose()
  }
})
