// 定时任务的调度和执行，对着假引擎、用可控的时钟：到点跑出会话、错过合并、重叠、并发上限、重启不重跑、各种失败。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parseSystemMessage } from '../../protocol/src/system-messages.mjs'
import type { TestClient } from './helpers.mjs'
import { settle, tempDir } from './helpers.mjs'
import {
  assertNotification,
  FakeClock,
  intervalTask,
  TaskEngine,
  taskRig,
  tasksClient,
  until,
} from './task-kit.mjs'

const MINUTE = 60_000

async function runs(client: TestClient, taskId: string | null = null): Promise<any[]> {
  return (await client.call('litch/task/runs/list', { taskId })).data
}

async function task(client: TestClient, id: string): Promise<any> {
  return (await client.call('litch/task/list', {})).data.find((item: any) => item.id === id)
}

test('到点在新会话里跑一个回合：会话起了名、进了索引，运行记录 succeeded、带摘要、未读；提示词前有说明', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: 'completed', answer: `日报写好了。${'很长'.repeat(400)}` })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task: created } = await client.call('litch/task/create', {
      ...intervalTask(target.stateDir),
      target: {
        kind: 'newThread',
        harness: 'pi',
        cwd: target.stateDir,
        workspaceId: null,
        settings: { model: 'gate', effort: 'high', permission: 'never' },
      },
    })
    client.close()
    await settle()
    // 没有客户端连着：到点照样跑
    target.clock.advance(5 * MINUTE)
    // 任务开的连接用完就关；剩下的一条是客户端走时会话树留的（引擎自己开的回合里设备工具要有执行方）
    await until('跑完', () => engine.turns.length === 1 && engine.live.length === 1)
    const start = engine.seen.find((item) => item.method === 'thread/start')
    assert.equal(start?.params.cwd, target.stateDir)
    assert.equal(start?.params.model, 'gate')
    // 假引擎没报权限预设：权限当作审批策略给
    assert.equal(start?.params.approvalPolicy, 'never')
    assert.equal(start?.params.threadSource, undefined)
    const turn = engine.turns[0]
    assert.equal(turn?.params.effort, 'high')
    const text = turn?.params.input[0].text as string
    assert.match(text, /^\[Scheduled task run\]/)
    assert.match(text, /Task: 整理日报/)
    assert.match(text, /No one is watching this run/)
    assert.ok(text.endsWith('---\n把今天的提交整理成日报。'))
    // 客户端认得回来（画成“定时任务 · 名字”卡片）
    assert.deepEqual(parseSystemMessage(text), {
      kind: 'scheduledTask',
      task: '整理日报',
      manual: false,
      prompt: '把今天的提交整理成日报。',
    })
    const thread = engine.threads.at(-1)
    assert.match(String(thread?.name), /^整理日报 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    const later = await tasksClient(target)
    await until('运行记好', async () => (await runs(later))[0]?.status === 'succeeded')
    const [run] = await runs(later)
    assert.equal(run.trigger, 'scheduled')
    assert.equal(run.scheduledFor, created.nextRunAt)
    assert.equal(run.coalesced, 0)
    assert.equal(run.threadId, thread?.id)
    assert.equal(run.turnId, turn?.turnId)
    assert.equal(run.read, false)
    assert.equal(run.summary.length, 500)
    assert.ok(run.summary.startsWith('日报写好了。'))
    const now = await task(later, created.id)
    assert.equal(now.unreadRuns, 1)
    assert.equal(now.lastRun.id, run.id)
    assert.equal(now.lastRunAt, run.startedAt)
    assert.equal(now.nextRunAt, created.nextRunAt + 300)
    // 会话进了索引：thread/list 合并出来的列表里有它
    const list = await later.call('thread/list', {})
    assert.ok(list.data.some((item: any) => item.id === thread?.id && item.harness === 'pi'))
  } finally {
    await target.close()
  }
})

test('错过了好几个时间点只跑一次：计划时间是最近的那个，coalesced 记其余的个数', async () => {
  const engine = new TaskEngine()
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task: created } = await client.call('litch/task/create', intervalTask(target.stateDir))
    // 睡了 17 分钟：5、10、15 三个时间点都错过了
    target.clock.advance(17 * MINUTE)
    await until('跑完', async () => (await runs(client))[0]?.status === 'succeeded')
    const all = await runs(client)
    assert.equal(all.length, 1)
    assert.equal(all[0].coalesced, 2)
    // 排上、建好会话、开始、结束各有一条运行变化的通知，形状照扩展定义
    await client.waitFor(
      (frame) =>
        frame.method === 'litch/task/run/changed' &&
        (frame.params as any).run.status === 'succeeded',
    )
    const changes = client.notifications.filter(
      (frame) => frame.method === 'litch/task/run/changed',
    )
    for (const frame of changes) assertNotification('litch/task/run/changed', frame.params)
    assert.deepEqual(
      [...new Set(changes.map((frame) => (frame.params as any).run.status))],
      ['queued', 'running', 'succeeded'],
    )
    assert.equal(all[0].scheduledFor, created.createdAt + 15 * 60)
    assert.equal((await task(client, created.id)).nextRunAt, created.createdAt + 20 * 60)
  } finally {
    await target.close()
  }
})

test('上一次还没结束就不另起，到了的时间点记到下一次；runNow 回的是在跑的那一次', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: null })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const { task: created } = await client.call('litch/task/create', intervalTask(target.stateDir))
    target.clock.advance(5 * MINUTE)
    await until('回合开始', () => engine.turns.length === 1)
    const running = (await runs(client))[0]
    await until('记成 running', async () => (await runs(client))[0]?.status === 'running')
    const again = await client.call('litch/task/runNow', { id: created.id })
    assert.equal(again.deduplicated, true)
    assert.equal(again.run.id, running.id)
    // 下一个时间点到了，上一次还在跑
    target.clock.advance(5 * MINUTE)
    await settle(50)
    assert.equal(engine.turns.length, 1)
    assert.equal((await runs(client)).length, 1)
    engine.finish(engine.turns[0] as any, 'completed', '好了')
    await until('第一次跑完', async () => (await runs(client))[0]?.status === 'succeeded')
    engine.script = () => ({ status: 'completed', answer: '第二次' })
    target.clock.advance(5 * MINUTE)
    await until('第二次跑完', async () => {
      const all = await runs(client)
      return all.length === 2 && all[0].status === 'succeeded'
    })
    assert.equal((await runs(client))[0].coalesced, 1)
  } finally {
    await target.close()
  }
})

test('整台设备同时在跑的有上限，多的排着，空出来再按计划时间先后开始', async () => {
  const engine = new TaskEngine()
  engine.script = () => ({ status: null })
  const target = taskRig({ pi: engine })
  try {
    const client = await tasksClient(target)
    const ids: string[] = []
    for (const name of ['一', '二', '三'])
      ids.push(
        (await client.call('litch/task/create', intervalTask(target.stateDir, 5, { name }))).task
          .id,
      )
    target.clock.advance(5 * MINUTE)
    await until('两个回合开始', () => engine.turns.length === 2)
    await settle(50)
    assert.equal(engine.turns.length, 2)
    const queued = (await runs(client)).filter((run) => run.status === 'queued')
    assert.equal(queued.length, 1)
    engine.finish(engine.turns[0] as any, 'completed', '好')
    await until('第三个开始', () => engine.turns.length === 3)
    for (const turn of engine.turns.slice(1)) engine.finish(turn, 'completed', '好')
    await until('都跑完', async () =>
      (await runs(client)).every((run) => run.status === 'succeeded'),
    )
  } finally {
    await target.close()
  }
})

test('设备进程重启不重跑同一个时间点；上次在跑的去会话里查结果，排着的接着跑', async () => {
  const stateDir = tempDir()
  const engine = new TaskEngine()
  engine.script = () => ({ status: null })
  const clock = new FakeClock()
  const first = taskRig({ pi: engine }, { stateDir }, clock)
  const client = await tasksClient(first)
  const work = join(stateDir, 'work')
  mkdirSync(work)
  const { task: created } = await client.call('litch/task/create', intervalTask(work))
  clock.advance(5 * MINUTE)
  await until('回合开始', () => engine.turns.length === 1)
  await until('记成 running', async () => (await runs(client))[0]?.status === 'running')
  // 设备进程退出，回合在引擎里接着跑完
  await first.device.close()
  engine.finish(engine.turns[0] as any, 'completed', '重启期间跑完了')
  const second = taskRig({ pi: engine }, { stateDir }, clock)
  try {
    const again = await tasksClient(second)
    await until('查回结果', async () => (await runs(again))[0]?.status === 'succeeded')
    const all = await runs(again)
    assert.equal(all.length, 1)
    assert.equal(all[0].summary, '重启期间跑完了')
    // 没有再跑这个时间点
    await settle(50)
    assert.equal(engine.turns.length, 1)
    assert.equal((await task(again, created.id)).nextRunAt, created.nextRunAt + 300)
  } finally {
    await second.close()
  }
})

test('上次在跑的回合还在跑：重启后接着等它；会话里查不到这个回合的记 interrupted', async () => {
  const stateDir = tempDir()
  const engine = new TaskEngine()
  engine.script = () => ({ status: null })
  const clock = new FakeClock()
  const first = taskRig({ pi: engine }, { stateDir }, clock)
  const client = await tasksClient(first)
  const { task: created } = await client.call(
    'litch/task/create',
    intervalTask(stateDir, 60, { status: 'paused' }),
  )
  await client.call('litch/task/runNow', { id: created.id })
  await until('记成 running', async () => (await runs(client))[0]?.status === 'running')
  await first.device.close()
  // 回合还在跑：重启后订阅会话接着等，结束了照实记
  const second = taskRig({ pi: engine }, { stateDir }, clock)
  const again = await tasksClient(second)
  await until('重新订阅', () => engine.seen.some((item) => item.method === 'thread/resume'))
  engine.finish(engine.turns[0] as any, 'completed', '接着等到了')
  await until('记好', async () => (await runs(again))[0]?.status === 'succeeded')
  assert.equal((await runs(again))[0].summary, '接着等到了')
  await again.call('litch/task/runNow', { id: created.id })
  await until('第二次在跑', async () => (await runs(again))[0]?.status === 'running')
  await second.device.close()
  // 引擎那边这个回合没了（比如引擎也重启了、没留下）：查不到，记 interrupted
  engine.results.clear()
  const third = taskRig({ pi: engine }, { stateDir }, clock)
  try {
    const last = await tasksClient(third)
    await until(
      '记成 interrupted',
      async () => (await runs(last))[0]?.error?.code === 'interrupted',
    )
    assert.equal((await runs(last))[0].status, 'failed')
    assert.equal((await task(last, created.id)).lastError.code, 'interrupted')
  } finally {
    await third.close()
  }
})
