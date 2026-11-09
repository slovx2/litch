import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import { openStage } from './fixtures/in-process.mjs'

test('活动回合查询不解析条目且按会话隔离，仍拦住未结清的回合', async () => {
  const stage = await openStage('active-turn-metadata')
  try {
    const client = await stage.connect('fixture')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    const db = Reflect.get(stage.store, 'db') as DatabaseSync
    // 故意不能解析的正文，证明互斥检查不会触碰历史内容；不落真实的大文件。
    db.prepare(
      "INSERT INTO turns(id,thread_id,status,items_json) VALUES(?,?,?,'invalid fixture json')",
    ).run('fixture-turn', thread.id, 'completed')
    assert.equal(stage.store.hasInProgressTurn(thread.id), false)
    db.prepare("UPDATE turns SET status='inProgress' WHERE id=?").run('fixture-turn')
    assert.equal(stage.store.hasInProgressTurn(thread.id), true)
    assert.equal(stage.store.hasInProgressTurn('another-thread'), false)
    assert.equal(await stage.session().onSpontaneousTurn(thread.id), false)
    db.prepare('DELETE FROM turns WHERE id=?').run('fixture-turn')
  } finally {
    await stage.dispose()
  }
})

test('自行续跑接入超时只中断未接上的回合，不销毁仍有后台工作的 CLI', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const runtime = new NativeClaudeRuntime()
  let interrupted = 0
  const session = {
    key: 'fixture',
    context: { claudeBackend: 'sdk' },
    closing: false,
    turn: null,
    attach: null,
    attachResolve: null,
    discard: false,
    backgroundTasks: new Set(['fixture-task']),
    query: {
      interrupt: async () => {
        interrupted++
      },
    },
  }
  const sessions = Reflect.get(runtime, 'sessions') as Map<string, unknown>
  sessions.set('fixture', session)
  Reflect.set(runtime, 'sessionHandlers', { onSpontaneousTurn: async () => true })
  Reflect.set(runtime, 'scheduleReap', () => {})
  try {
    const attached = Reflect.get(runtime, 'currentTurn').call(runtime, session) as Promise<unknown>
    await Promise.resolve()
    t.mock.timers.tick(10_001)
    assert.equal(await attached, null)
    assert.equal(interrupted, 1)
    assert.equal(session.closing, false)
    assert.equal(session.backgroundTasks.size, 1)
    await assert.rejects(
      runtime.runTurn(
        {
          threadId: 'fixture',
          turnId: 'late',
          spontaneous: true,
          claudeBackend: 'sdk',
        } as RuntimeTurnContext,
        {} as RuntimeHandlers,
      ),
      /接入窗口已结束/,
    )
    assert.equal(sessions.size, 1)
  } finally {
    sessions.clear()
    t.mock.timers.reset()
    await runtime.stop()
  }
})

test('自行续跑只查询活动回合元数据，不能加载整份历史正文', async () => {
  const stage = await openStage('spontaneous-history')
  const list = stage.store.listTurns.bind(stage.store)
  try {
    const client = await stage.connect('fixture')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    // 用禁止整份历史读取代替真的写入几十 MB，守住后台续跑的入口。
    stage.store.listTurns = () => {
      throw new Error('不得为活动状态物化整份历史')
    }
    assert.equal(await stage.session().onSpontaneousTurn(thread.id), true)
    const started = await client.notification('turn/started')
    assert.equal((await client.completed(started.params.turn.id)).status, 'completed')
  } finally {
    stage.store.listTurns = list
    await stage.dispose()
  }
})

test('CLI 仍在但自行续跑接入窗口结束，不得误报进程退出或另起 CLI', async () => {
  const runtime = new NativeClaudeRuntime()
  const sessions = Reflect.get(runtime, 'sessions') as Map<string, unknown>
  sessions.set('fixture', {
    context: { claudeBackend: 'sdk' },
    closing: false,
    turn: null,
    attach: null,
  })
  const context = {
    threadId: 'fixture',
    turnId: 'background',
    spontaneous: true,
    claudeBackend: 'sdk',
  } as RuntimeTurnContext
  try {
    await assert.rejects(runtime.runTurn(context, {} as RuntimeHandlers), (error: Error) => {
      assert.match(error.message, /接入窗口已结束/)
      assert.doesNotMatch(error.message, /CLI 已退出/)
      return true
    })
    assert.equal(sessions.size, 1, '保留原进程及其后台工作')
  } finally {
    sessions.clear()
    await runtime.stop()
  }
})
