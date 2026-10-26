// 决 430：子会话、定时任务的回合结束时还有后台任务在跑——照常算结束、回报里注明；后台跑完以后再报一次：
// 引擎会自己接着做的，那一回合结束时报；不会的（原生 codex），跑完时补报。
import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import { resultOf } from './fake-engine.mjs'
import type { FakeUpstream } from './fake-upstream.mjs'
import { settle } from './helpers.mjs'
import { intervalTask, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'
import {
  brief,
  until as eventually,
  litch,
  parent,
  refuseSteer,
  SESSIONS,
  treeRig,
} from './tree-kit.mjs'

const task = (id: string, status: string, title = 'npm test') => ({
  id,
  kind: 'shell',
  title,
  status,
  startedAt: 1_000,
  ...(status === 'running' ? {} : { endedAt: 13_000 }),
})

/** 引擎报一份集合（适配器的引擎都发 litch/thread/background/changed） */
function background(engine: FakeUpstream, threadId: string, tasks: unknown[], wakes: boolean) {
  engine.notify(BACKGROUND_TASKS_NOTIFICATION.changed, {
    threadId,
    tasks,
    wakesOnFinish: wakes,
  })
}

async function child(env: ReturnType<typeof treeRig>) {
  const client = await litch(env)
  const { threadId } = await parent(client)
  const childId = resultOf(
    (
      await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: '跑测试',
        ...brief('跑一遍测试。'),
        harness: 'claude-code',
        initiation: 'user_asked',
      })
    )?.answer,
  ).thread_id as string
  return { threadId, childId }
}

test('BG-REPORT-001 子会话：回报注明还有几个在跑；后台跑完、引擎自己续跑的那一回合结束时照常再报一次', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { threadId, childId } = await child(env)
    background(env.claude, childId, [task('b1', 'running')], true)
    env.claude.end(childId, 'completed', '测试在后台跑着')
    const notes = () => env.device.sessionTree.store.notes(threadId)
    await eventually(() => notes().length === 1, '第一条回报')
    assert.equal(notes()[0]?.backgroundTasks, 1)
    background(env.claude, childId, [task('b1', 'completed')], true)
    await settle(30)
    assert.equal(notes().length, 1, '引擎会接着做：跑完时不另报，等那一回合')
    env.claude.selfTurn(childId)
    env.claude.end(childId, 'completed', '48 个用例全部通过')
    await eventually(() => notes().length === 2, '续跑的回合结束后再报一次')
    assert.equal(notes()[1]?.excerpt, '48 个用例全部通过')
    assert.equal(notes()[1]?.backgroundTasks, undefined)
  } finally {
    await env.close()
  }
})

test('BG-REPORT-002 子会话：引擎不会接着做的，后台全部结束时补一条回报写各任务的结局；没写过在跑的不补', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { threadId, childId } = await child(env)
    const notes = () => env.device.sessionTree.store.notes(threadId)
    background(env.claude, childId, [task('b1', 'running'), task('b2', 'running', 'dev')], false)
    env.claude.end(childId, 'completed', '起了两个')
    await eventually(() => notes().length === 1, '第一条回报')
    assert.equal(notes()[0]?.backgroundTasks, 2)
    background(env.claude, childId, [task('b1', 'running'), task('b2', 'failed', 'dev')], false)
    await settle(30)
    assert.equal(notes().length, 1, '还有一个在跑')
    background(env.claude, childId, [task('b1', 'completed'), task('b2', 'failed', 'dev')], false)
    await eventually(() => notes().length === 2, '跑完补报')
    assert.equal(notes()[1]?.status, 'completed')
    assert.equal(
      notes()[1]?.excerpt,
      'Background tasks finished: npm test (completed); dev (failed)',
    )
    // 再起一个、跑完：上一次回报之后没写过在跑的，不补
    background(env.claude, childId, [task('b3', 'running')], false)
    background(env.claude, childId, [task('b3', 'completed')], false)
    await settle(30)
    assert.equal(notes().length, 2)
  } finally {
    await env.close()
  }
})

test('BG-REPORT-005 子会话：后台任务被用户停了、引擎不会续跑（会续跑的 harness 也一样）：补一条不唤醒的收尾回报，写明是用户停的', async () => {
  for (const wakes of [true, false]) {
    const env = treeRig()
    refuseSteer(env.pi)
    try {
      const { threadId, childId } = await child(env)
      const notes = () => env.device.sessionTree.store.notes(threadId)
      env.claude.handlers['thread/backgroundTerminals/terminate'] = () => ({ terminated: true })
      background(env.claude, childId, [task('b1', 'running', 'npm run dev')], wakes)
      env.claude.end(childId, 'completed', '起了 dev 服务')
      await eventually(() => notes().length === 1, '第一条回报')
      const client = await litch(env)
      await client.call('thread/backgroundTerminals/terminate', {
        threadId: childId,
        processId: 'p1',
      })
      background(env.claude, childId, [task('b1', 'stopped', 'npm run dev')], wakes)
      await eventually(() => notes().length === 2, `收尾回报（wakes=${wakes}）`)
      assert.equal(
        notes()[1]?.excerpt,
        'Background tasks finished: npm run dev (stopped by the user)',
      )
      assert.equal(notes()[1]?.wake, false, '用户停的不唤醒父会话（决 481）')
    } finally {
      await env.close()
    }
  }
})

test('BG-REPORT-006 子会话：不是用户停的（进程退出之类）照旧写 stopped；会续跑的 harness 有自己跑完的就等它续跑的那一回合', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { threadId, childId } = await child(env)
    const notes = () => env.device.sessionTree.store.notes(threadId)
    background(env.claude, childId, [task('b1', 'running'), task('b2', 'running', 'dev')], true)
    env.claude.end(childId, 'completed', '起了两个')
    await eventually(() => notes().length === 1, '第一条回报')
    // 一个自己跑完、一个停了：引擎会为跑完的那个接着做，不补
    background(env.claude, childId, [task('b1', 'completed'), task('b2', 'stopped', 'dev')], true)
    await settle(30)
    assert.equal(notes().length, 1)
    env.claude.selfTurn(childId)
    env.claude.end(childId, 'completed', '测试过了')
    await eventually(() => notes().length === 2, '续跑的回合结束后再报')
    // 再起一个，CLI 进程退出时它跟着停了（没人点停止）：补报、照常唤醒
    env.claude.selfTurn(childId)
    background(env.claude, childId, [task('b3', 'running', 'serve')], true)
    env.claude.end(childId, 'completed', '又起了一个')
    await eventually(() => notes().length === 3, '第三条回报')
    background(env.claude, childId, [task('b3', 'stopped', 'serve')], true)
    await eventually(() => notes().length === 4, '收尾回报')
    assert.equal(notes()[3]?.excerpt, 'Background tasks finished: serve (stopped)')
    assert.equal(notes()[3]?.wake, true)
  } finally {
    await env.close()
  }
})

/** 立刻跑一次任务；回合由测试来结束。返回客户端、任务号和那个回合 */
async function runOnce(target: ReturnType<typeof taskRig>, engine: TaskEngine) {
  engine.script = () => ({ status: null })
  const client = await tasksClient(target)
  const { task: created } = await client.call('litch/task/create', {
    ...intervalTask(target.stateDir),
    target: {
      kind: 'newThread',
      harness: 'pi',
      cwd: target.stateDir,
      workspaceId: null,
      settings: { model: null, effort: null, permission: null },
    },
  })
  await client.call('litch/task/runNow', { id: created.id })
  await until('回合开始', () => engine.turns.length === 1)
  const turn = engine.turns[0] as NonNullable<(typeof engine.turns)[0]>
  return { client, taskId: created.id as string, turn }
}

const runs = async (client: Awaited<ReturnType<typeof tasksClient>>, taskId: string) =>
  (await client.call('litch/task/runs/list', { taskId })).data as any[]

test('BG-REPORT-003 定时任务：运行照常结束、记着还有几个在跑；续跑的回合结束时摘要换成它的回答、数清零、标成没看过，然后关掉连接', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine }, { tasks: { timing: { followSettleMs: 50 } } })
  try {
    const { client, taskId, turn } = await runOnce(target, engine)
    background(engine, turn.threadId, [task('b1', 'running')], true)
    engine.finish(turn, 'completed', '测试在后台跑着')
    await until('运行记好', async () => (await runs(client, taskId))[0]?.status === 'succeeded')
    let [run] = await runs(client, taskId)
    assert.equal(run.backgroundTasks, 1)
    assert.equal(run.summary, '测试在后台跑着')
    await client.call('litch/task/runs/markRead', { taskId, runIds: [run.id] })
    assert.equal(engine.live.length >= 1, true, '还在盯着')
    background(engine, turn.threadId, [task('b1', 'completed')], true)
    // 引擎自己续跑：没有用户消息，回合带来历
    const self = { id: 'self-1', status: 'inProgress', items: [], litchOrigin: 'backgroundTask' }
    engine.notify('turn/started', { threadId: turn.threadId, turn: self })
    engine.notify('item/completed', {
      threadId: turn.threadId,
      turnId: 'self-1',
      item: { type: 'agentMessage', id: 'self-1-a', text: '48 个用例全部通过' },
    })
    engine.notify('turn/completed', {
      threadId: turn.threadId,
      turn: { ...self, status: 'completed' },
    })
    await until('摘要换了', async () => (await runs(client, taskId))[0]?.summary !== run.summary)
    ;[run] = await runs(client, taskId)
    assert.equal(run.summary, '48 个用例全部通过')
    assert.equal(run.backgroundTasks, undefined)
    assert.equal(run.read, false)
    assert.equal(run.status, 'succeeded')
    // 只看任务自己那条：有后台任务在跑时会话树的连接也跟着这个会话（session-tree.mts 的 follow），它不关
    await until('任务的连接关了', () => !turn.connection.open, 2000)
  } finally {
    await target.close()
  }
})

test('BG-REPORT-004 定时任务：引擎不会接着做的，后台全部结束时把数清零、标成没看过，关掉连接；中途用户自己的回合不算', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const { client, taskId, turn } = await runOnce(target, engine)
    background(engine, turn.threadId, [task('b1', 'running')], false)
    engine.finish(turn, 'completed', '起了 dev 服务')
    await until('运行记好', async () => (await runs(client, taskId))[0]?.status === 'succeeded')
    let [run] = await runs(client, taskId)
    assert.equal(run.backgroundTasks, 1)
    await client.call('litch/task/runs/markRead', { taskId, runIds: [run.id] })
    // 不是续跑的回合（比如用户自己在会话里说了话）：摘要不动
    const other = { id: 'user-1', status: 'inProgress', items: [] }
    engine.notify('turn/started', { threadId: turn.threadId, turn: other })
    engine.notify('item/completed', {
      threadId: turn.threadId,
      turnId: 'user-1',
      item: { type: 'agentMessage', id: 'user-1-a', text: '别的事' },
    })
    engine.notify('turn/completed', {
      threadId: turn.threadId,
      turn: { ...other, status: 'completed' },
    })
    await settle(50)
    ;[run] = await runs(client, taskId)
    assert.equal(run.summary, '起了 dev 服务')
    assert.equal(run.read, true)
    background(engine, turn.threadId, [task('b1', 'failed', 'dev')], false)
    await until(
      '数清零',
      async () => (await runs(client, taskId))[0]?.backgroundTasks === undefined,
    )
    ;[run] = await runs(client, taskId)
    assert.equal(run.summary, '起了 dev 服务')
    assert.equal(run.read, false)
    // 只看任务自己那条：有后台任务在跑时会话树的连接也跟着这个会话（session-tree.mts 的 follow），它不关
    await until('任务的连接关了', () => !turn.connection.open, 2000)
  } finally {
    await target.close()
  }
})
