// 定时任务回合里的审批，经设备进程整个走一遍（task-approvals.mts 接在 task-run.mts、task-scheduler.mts 上）：
// 假引擎照 Pi 这类引擎的规矩发请求（发给订阅了会话的每条连接，后来订阅的补收到，有人答了告诉每条订阅连接），
// 设备进程的内部连接不再替它回“没人可送”，等满时限替人拒绝；中途有客户端打开会话答了就取消；
// 客户端断开、另一条连上来还看得到；运行记录和通知里的 approvals 照扩展定义。
import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeControl, managed } from './fake-control.mjs'
import type { FakeConnection } from './fake-upstream.mjs'
import { settle, type TestClient } from './helpers.mjs'
import {
  assertNotification,
  assertResponse,
  intervalTask,
  TaskEngine,
  taskRig,
  tasksClient,
  until,
} from './task-kit.mjs'

const MINUTE = 60_000
const APPROVAL = 'item/commandExecution/requestApproval'

/** 会发审批的假引擎：记着谁订阅了哪个会话，还在等的请求补送给后来订阅的，答了就告诉每条订阅连接 */
class AskingEngine extends TaskEngine {
  readonly subscribers = new Map<string, Set<FakeConnection>>()
  readonly pending = new Map<string, { threadId: string; frame: any }>()

  constructor() {
    super('pi')
    const start = this.handlers['thread/start'] as NonNullable<(typeof this.handlers)[string]>
    const resume = this.handlers['thread/resume'] as NonNullable<(typeof this.handlers)[string]>
    this.handlers['thread/start'] = (params, connection) => {
      const result: any = start(params, connection)
      this.subscribe(result.thread.id, connection)
      return result
    }
    this.handlers['thread/resume'] = (params, connection) => {
      const result = resume(params, connection)
      this.subscribe(params.threadId, connection)
      // 应答之后补送还在等的
      setImmediate(() => {
        for (const entry of this.pending.values())
          if (entry.threadId === params.threadId) connection.send(entry.frame)
      })
      return result
    }
  }

  private subscribe(threadId: string, connection: FakeConnection): void {
    const set = this.subscribers.get(threadId) ?? new Set()
    set.add(connection)
    this.subscribers.set(threadId, set)
  }

  /** 回合里要审批：发给订阅着的连接 */
  ask(threadId: string, turnId: string, id: string): void {
    const frame = {
      id,
      method: APPROVAL,
      params: { threadId, turnId, itemId: 'cmd', command: 'rm -rf build' },
    }
    this.pending.set(id, { threadId, frame })
    for (const connection of this.subscribers.get(threadId) ?? [])
      if (connection.open) connection.send(frame)
  }

  /** 哪条连接答了这条请求、答的什么 */
  answerOf(id: string): { connection: FakeConnection; frame: any } | null {
    for (const connection of this.connections) {
      const frame = connection.answers.find((answer) => answer.id === id)
      if (frame) return { connection, frame }
    }
    return null
  }

  /** 第一份答复生效：请求结束，告诉订阅着的连接 */
  async resolveWhenAnswered(id: string): Promise<{ connection: FakeConnection; frame: any }> {
    let answered: { connection: FakeConnection; frame: any } | null = null
    await until(`${id} 有人答`, () => {
      answered = this.answerOf(id)
      return answered !== null
    })
    const entry = this.pending.get(id)
    this.pending.delete(id)
    for (const connection of this.subscribers.get(entry?.threadId ?? '') ?? [])
      if (connection.open)
        connection.send({
          method: 'serverRequest/resolved',
          params: { threadId: entry?.threadId, requestId: id },
        })
    return answered as unknown as { connection: FakeConnection; frame: any }
  }
}

async function lastRun(client: TestClient): Promise<any> {
  const listed = await client.call('litch/task/runs/list', {})
  assertResponse('litch/task/runs/list', listed)
  return listed.data[0]
}

/** 建一个任务、立即跑，回合不自己结束；返回回合 */
async function startRun(client: TestClient, engine: AskingEngine, stateDir: string) {
  engine.script = () => ({ status: null })
  const { task } = await client.call('litch/task/create', intervalTask(stateDir))
  await client.call('litch/task/runNow', { id: task.id })
  await until('回合开始', async () => (await lastRun(client))?.status === 'running')
  const turn = engine.turns[0]
  if (!turn) throw new Error('没有回合')
  return turn
}

test('TASK-APPROVAL-DEVICE-001：没人答，内部连接不回“没人可送”，等满 30 分钟按拒绝答复，运行记录里写着', async () => {
  const engine = new AskingEngine()
  const target = taskRig({ pi: engine }, { engineLinks: { heldGraceMs: 20, heldRecheckMs: 20 } })
  try {
    const client = await tasksClient(target)
    const turn = await startRun(client, engine, target.stateDir)
    engine.ask(turn.threadId, turn.turnId, 'ask-1')
    await until('记进运行', async () => (await lastRun(client)).approvals?.length === 1)
    const waiting = await lastRun(client)
    assert.equal(waiting.approvals[0].state, 'waiting')
    assert.equal(waiting.approvals[0].title, 'rm -rf build')
    assert.equal(waiting.approvals[0].declineAt - waiting.approvals[0].requestedAt, 30 * 60)
    const changed: any = await client.waitFor(
      (frame: any) => frame.method === 'litch/task/run/changed' && frame.params.run.approvals,
    )
    assertNotification('litch/task/run/changed', changed.params)
    // 以前这里过一小会儿就替引擎回了“没人可送”
    await settle(100)
    assert.equal(engine.answerOf('ask-1'), null)
    target.clock.advance(29 * MINUTE)
    await settle(20)
    assert.equal(engine.answerOf('ask-1'), null)
    target.clock.advance(MINUTE)
    const answered = await engine.resolveWhenAnswered('ask-1')
    assert.equal(answered.connection, turn.connection, '由任务的内部连接答')
    assert.deepEqual(answered.frame.result, { decision: 'decline' })
    await until(
      '记成自动拒绝',
      async () => (await lastRun(client)).approvals[0].state === 'autoDeclined',
    )
    engine.finish(turn, 'completed', '没批下来，跳过了')
    await until('跑完', async () => (await lastRun(client)).status === 'succeeded')
    const done = await lastRun(client)
    assert.equal(done.approvals[0].state, 'autoDeclined')
    assert.ok(done.approvals[0].settledAt >= done.approvals[0].declineAt)
  } finally {
    await target.close()
  }
})

test('TASK-APPROVAL-DEVICE-002：等着的时候客户端打开会话就收到这条审批，答了取消计时', async () => {
  const engine = new AskingEngine()
  const target = taskRig({ pi: engine }, { engineLinks: { heldGraceMs: 20, heldRecheckMs: 20 } })
  try {
    const client = await tasksClient(target)
    const turn = await startRun(client, engine, target.stateDir)
    engine.ask(turn.threadId, turn.turnId, 'ask-2')
    await until('记进运行', async () => (await lastRun(client)).approvals?.length === 1)
    assert.equal(
      client.requests.some((frame) => frame.method === APPROVAL),
      false,
      '没打开会话前收不到',
    )
    await client.call('thread/resume', { threadId: turn.threadId })
    const request: any = await client.waitFor(
      (frame) => frame.method === APPROVAL && frame.id != null,
    )
    assert.equal(request.params.command, 'rm -rf build')
    client.answer(request.id, { decision: 'accept' })
    const answered = await engine.resolveWhenAnswered('ask-2')
    assert.notEqual(answered.connection, turn.connection, '客户端答的')
    assert.deepEqual(answered.frame.result, { decision: 'accept' })
    await until(
      '记成有了结果',
      async () => (await lastRun(client)).approvals[0].state === 'resolved',
    )
    target.clock.advance(60 * MINUTE)
    await settle(50)
    assert.equal(
      turn.connection.answers.some((frame) => frame.id === 'ask-2'),
      false,
      '有人答了就不再替人拒绝',
    )
    engine.finish(turn, 'completed', '好了')
    await until('跑完', async () => (await lastRun(client)).status === 'succeeded')
  } finally {
    await target.close()
  }
})

test('TASK-APPROVAL-DEVICE-003：拿着审批的客户端断开了，请求照样等着；另一个客户端连上来打开会话还看得到；设置改了只影响之后的', async () => {
  const engine = new AskingEngine()
  const control = new FakeControl([managed('pi')])
  control.tasks = { approvalTimeoutMinutes: 10 }
  control.push()
  const target = taskRig(
    {},
    {
      control,
      dial: () => engine.connector,
      engineLinks: { heldGraceMs: 20, heldRecheckMs: 20 },
    },
  )
  try {
    const first = await tasksClient(target)
    const turn = await startRun(first, engine, target.stateDir)
    engine.ask(turn.threadId, turn.turnId, 'ask-3')
    await until('记进运行', async () => (await lastRun(first)).approvals?.length === 1)
    const recorded = (await lastRun(first)).approvals[0]
    assert.equal(recorded.declineAt - recorded.requestedAt, 10 * 60, '按设置的 10 分钟')
    await first.call('thread/resume', { threadId: turn.threadId })
    await first.waitFor((frame) => frame.method === APPROVAL && frame.id != null)
    first.close()
    // 以前：客户端都走了，内部连接隔一会儿就替引擎回“没人可送”
    await settle(150)
    assert.equal(engine.answerOf('ask-3'), null)
    control.taskSettings({ approvalTimeoutMinutes: 60 })
    const second = await tasksClient(target)
    await second.call('thread/resume', { threadId: turn.threadId })
    const again: any = await second.waitFor(
      (frame) => frame.method === APPROVAL && frame.id != null,
    )
    assert.equal(again.params.command, 'rm -rf build')
    // 还是原来的 10 分钟
    target.clock.advance(10 * MINUTE)
    const answered = await engine.resolveWhenAnswered('ask-3')
    assert.equal(answered.connection, turn.connection)
    assert.deepEqual(answered.frame.result, { decision: 'decline' })
    await second.waitFor(
      (frame: any) =>
        frame.method === 'serverRequest/resolved' && frame.params.requestId === again.id,
    )
    await until(
      '记成自动拒绝',
      async () => (await lastRun(second)).approvals[0].state === 'autoDeclined',
    )
    // 设置改过之后的新请求按 60 分钟
    engine.ask(turn.threadId, turn.turnId, 'ask-4')
    await until('第二条', async () => (await lastRun(second)).approvals?.length === 2)
    const later = (await lastRun(second)).approvals[1]
    assert.equal(later.declineAt - later.requestedAt, 60 * 60)
    engine.finish(turn, 'completed', '好了')
    await until('跑完', async () => (await lastRun(second)).status === 'succeeded')
    await until(
      '回合结束时还在等的记成有了结果',
      async () => (await lastRun(second)).approvals[1].state === 'resolved',
    )
  } finally {
    await target.close()
  }
})
