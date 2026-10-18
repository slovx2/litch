// 模拟核心里的定时任务：界面在浏览器里对着它调，任务的自检也对着它跑，
// 所以它要和真的核心一个样——立即运行真的演一次、结束算未读、打开会话算看过、记号跟着变、冲突不覆盖。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  type SessionSummary,
  type SidebarOp,
  serveChannel,
  type TasksOp,
  type TasksView,
  type TaskView,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

function setup() {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 10 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const rows = new Map<string, SessionSummary>()
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        for (const entry of data.sessions) rows.set(entry.id, entry)
      },
      delta(ops: SidebarOp[]) {
        for (const op of ops) {
          if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
          else if (op.op === 'session.remove') rows.delete(op.sessionId)
        }
      },
    },
  )
  const tasks = new Map<string, TaskView>()
  const views = new Map<string, TasksView>()
  const ops: TasksOp[] = []
  for (const deviceId of ['local', 'nas', 'gpu']) {
    channel.subscribe(
      { kind: 'tasks', deviceId },
      {
        snapshot(data) {
          views.set(deviceId, data)
          if (deviceId === 'local') for (const task of data.tasks) tasks.set(task.id, task)
        },
        delta(list: TasksOp[]) {
          if (deviceId !== 'local') return
          for (const op of list) {
            ops.push(op)
            if (op.op === 'task.upsert') tasks.set(op.task.id, op.task)
            else if (op.op === 'task.remove') tasks.delete(op.taskId)
          }
        },
      },
    )
  }
  /** 让模拟核心把手上的事做完：时钟往前拨，通道把积压的送完 */
  const pass = async (ms: number) => {
    for (let at = 0; at < ms; at += 20) {
      time.advance(20)
      await settle()
    }
  }
  /** 发一条命令：模拟核心要过一小会儿才应答，时钟一边拨着一边等 */
  const command = async (name: string, params: object): Promise<unknown> => {
    let done = false
    const reply = channel
      .command(name as never, { deviceId: 'local', ...params } as never)
      .finally(() => {
        done = true
      })
    // 等的这一会儿里先接住：失败的应答这时还没人 await
    reply.catch(() => {})
    for (let round = 0; round < 50 && !done; round++) await pass(20)
    return reply
  }
  return { channel, rows, tasks, views, ops, pass, command }
}

test('示例：本机和 build-01 有任务，nas 不支持，gpu-box 还没连上；示例会话带着记号', async () => {
  const w = setup()
  await w.pass(40)
  assert.equal(w.views.get('local')?.available, true)
  assert.equal(w.views.get('nas')?.available, false)
  assert.equal(w.views.get('gpu')?.available, null)
  const kinds = new Set([...w.tasks.values()].map((task) => task.target.kind))
  assert.deepEqual([...kinds].sort(), ['newThread', 'thread'])
  const last = new Set<string>([...w.tasks.values()].map((task) => task.lastRun?.status ?? 'none'))
  for (const status of ['succeeded', 'failed', 'queued', 'running', 'none'])
    assert.ok(last.has(status), status)
  assert.ok([...w.tasks.values()].some((task) => task.status === 'paused'))
  assert.ok([...w.tasks.values()].some((task) => task.unreadRuns > 0))
  assert.equal(w.rows.get('s8')?.task?.kind, 'target')
  assert.equal(w.rows.get('s4')?.task?.kind, 'run')
  assert.equal(w.rows.get('s1')?.task, null)
})

test('立即运行：排队、开出一个带记号的会话、跑完算未读并标 finished；重复点不另起；打开那个会话就看过了', async () => {
  const w = setup()
  await w.pass(40)
  const before = new Set(w.rows.keys())
  const first = (await w.command('tasks.runNow', { taskId: 'task-standup' })) as {
    deduplicated: boolean
    run: { id: string }
  }
  const again = (await w.command('tasks.runNow', { taskId: 'task-standup' })) as {
    deduplicated: boolean
  }
  assert.deepEqual([first.deduplicated, again.deduplicated], [false, true])
  await w.pass(400)
  const spawned = [...w.rows.values()].find((row) => !before.has(row.id))
  assert.ok(spawned, '跑出来一个新会话')
  assert.equal(spawned.task?.kind, 'run')
  assert.equal(spawned.unread, true)
  const finished = w.ops.filter((op) => op.op === 'run.upsert' && op.finished)
  assert.equal(finished.length, 1)
  assert.equal(w.tasks.get('task-standup')?.unreadRuns, 1)
  assert.equal(w.tasks.get('task-standup')?.lastRun?.status, 'succeeded')
  // 打开它：这一次运行算看过了
  w.channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: spawned.id },
    { snapshot() {}, delta() {} },
  )
  await w.pass(40)
  assert.equal(w.tasks.get('task-standup')?.unreadRuns, 0)
})

test('提示词里带“失败”的那一次失败了，记着原因；在已有会话里接着发的任务跑在那个会话里', async () => {
  const w = setup()
  await w.pass(40)
  // 依赖检查的提示词里没有“失败”：先把它改成有的
  const deps = w.tasks.get('task-deps')
  assert.ok(deps)
  await w.command('tasks.update', {
    taskId: 'task-deps',
    revision: deps.revision,
    patch: { prompt: '故意失败一次' },
  })
  await w.command('tasks.runNow', { taskId: 'task-deps' })
  await w.pass(400)
  assert.equal(w.tasks.get('task-deps')?.lastRun?.status, 'failed')
  assert.equal(w.tasks.get('task-deps')?.lastError?.code, 'turnFailed')
  // 构建监控在 s8 里：先等示例里那一次在跑的（它不会自己结束），所以立即运行回的是它
  const watch = (await w.command('tasks.runNow', { taskId: 'task-watch' })) as {
    deduplicated: boolean
  }
  assert.equal(watch.deduplicated, true)
})

test('改任务：版本对不上是冲突，最新的先发出去；暂停、删除照着改，删了记号跟着没', async () => {
  const w = setup()
  await w.pass(40)
  const failure = (await w
    .command('tasks.update', { taskId: 'task-standup', revision: 1, patch: { name: 'x' } })
    .catch((error: unknown) => error)) as ChannelError
  assert.equal(failure.code, 'conflict')
  const paused = (await w.command('tasks.pause', { taskId: 'task-standup', paused: true })) as {
    task: TaskView
  }
  assert.equal(paused.task.status, 'paused')
  assert.equal(paused.task.nextRunAt, null)
  await w.command('tasks.delete', { taskId: 'task-watch' })
  await w.pass(40)
  assert.equal(w.tasks.has('task-watch'), false)
  assert.equal(w.rows.get('s8')?.task, null)
  const gone = (await w
    .command('tasks.runNow', { taskId: 'task-watch' })
    .catch((error: unknown) => error)) as ChannelError
  assert.equal(gone.code, 'notFound')
})

test('运行记录分页：每页 50 条，nextCursor 接着往下', async () => {
  const w = setup()
  await w.pass(40)
  const first = (await w.command('tasks.runs', { taskId: 'task-standup' })) as {
    runs: unknown[]
    nextCursor: string | null
  }
  assert.equal(first.runs.length, 50)
  assert.ok(first.nextCursor)
  const second = (await w.command('tasks.runs', {
    taskId: 'task-standup',
    cursor: first.nextCursor,
  })) as { runs: unknown[]; nextCursor: string | null }
  assert.equal(second.runs.length, 15)
  assert.equal(second.nextCursor, null)
})
