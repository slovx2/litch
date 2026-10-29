import assert from 'node:assert/strict'
import test from 'node:test'
import { PowerActivity, type PowerActivityReport } from '../src/power-activity.mjs'
import type { Connector, WireHandlers } from '../src/wire.mjs'
import { isObject } from '../src/wire.mjs'

function engine() {
  let data: unknown[] = []
  let fail = false
  let hold = false
  let pending: (() => void) | undefined
  let closes = 0
  const methods: string[] = []
  const queries: { threadIds?: string[] }[] = []
  let runtimeKnown = true
  let hidden: { id: string; status: { type: string } }[] = []
  const connect: Connector = async (handlers: WireHandlers) => ({
    send(raw) {
      const frame = JSON.parse(raw)
      if (frame.id === undefined) return
      methods.push(frame.method)
      const answer = () => {
        let result: unknown = {}
        if (frame.method === 'litch/internal/power/activity') {
          queries.push(frame.params)
          const rows = [...data, ...hidden].filter(isObject)
          const ids: string[] = frame.params.threadIds ?? rows.map((row) => String(row.id))
          result = {
            threads: ids.map((id) => {
              const row = rows.find((row) => row.id === id)
              const background = isObject(row?.litchBackground) ? row.litchBackground : null
              return {
                threadId: id,
                active: isObject(row?.status) && row.status.type === 'active',
                background:
                  Array.isArray(background?.tasks) &&
                  background.tasks.some((task) => isObject(task) && task.status === 'running'),
              }
            }),
          }
        }
        handlers.message(
          JSON.stringify(
            fail || (!runtimeKnown && frame.method === 'litch/internal/power/activity')
              ? { id: frame.id, error: { code: -32000, message: 'offline' } }
              : { id: frame.id, result },
          ),
        )
      }
      if (frame.method === 'litch/internal/power/activity' && hold) pending = answer
      else queueMicrotask(answer)
    },
    close() {
      closes++
    },
  })
  return {
    connect,
    methods,
    queries,
    runtimeUnknown() {
      runtimeKnown = false
    },
    hidden(value: typeof hidden) {
      hidden = value
    },
    data(value: unknown[]) {
      data = value
    },
    fail() {
      fail = true
    },
    recover() {
      fail = false
    },
    hold() {
      hold = true
    },
    release() {
      hold = false
      pending?.()
    },
    closes: () => closes,
  }
}
const thread = (id: string, type: string) => ({
  id,
  status: { type },
  litchBackground: { tasks: [] },
})
const total = (activity: PowerActivity) =>
  activity.snapshot().sources.reduce((sum, source) => sum + source.working, 0)
const turn = (threadId: string, id: string) => ({ threadId, turn: { id } })

test('回合去重、等待审批继续保持、旧完成不能结束新回合、迟到开始不复活', () => {
  let now = 1000
  const activity = new PowerActivity({
    harnesses: () => [],
    report: async () => {},
    now: () => now,
  })
  activity.notification('pi', 'turn/started', turn('a', '1'))
  now += 1000
  activity.notification('pi', 'turn/started', turn('a', '1'))
  assert.equal(total(activity), 1)
  assert.equal(activity.snapshot().sources[0]?.observedAgoMs, 1000)
  activity.notification('pi', 'item/tool/requestUserInput', { threadId: 'a' })
  assert.equal(total(activity), 1)
  activity.notification('pi', 'turn/started', turn('a', '2'))
  activity.notification('pi', 'turn/completed', turn('a', '1'))
  assert.equal(total(activity), 1)
  activity.notification('pi', 'turn/completed', turn('a', '2'))
  activity.notification('pi', 'turn/started', turn('a', '2'))
  assert.equal(total(activity), 0)
  activity.close()
})

test('单调时钟的小数毫秒转为整数，符合Go控制通道int64形状', () => {
  let now = 1000.125
  const activity = new PowerActivity({
    harnesses: () => [],
    report: async () => {},
    now: () => now,
  })
  activity.notification('pi', 'turn/started', turn('a', '1'))
  now = 1001.25
  assert.equal(activity.snapshot().sources[0]?.observedAgoMs, 2)
  activity.close()
})

test('active状态通知保留新回合身份，跨连接迟到的旧completed不能清掉它', () => {
  const activity = new PowerActivity({ harnesses: () => [], report: async () => {} })
  activity.notification('pi', 'turn/started', turn('a', 'new'))
  activity.notification('pi', 'thread/status/changed', {
    threadId: 'a',
    status: { type: 'active' },
  })
  activity.notification('pi', 'turn/completed', turn('a', 'old'))
  assert.equal(total(activity), 1)
  activity.notification('pi', 'turn/completed', turn('a', 'new'))
  assert.equal(total(activity), 0)
  activity.close()
})

test('独立回合、pending和后台去重，缓存重复读取不能刷新后台证据', () => {
  let now = 1000
  let background = [{ harness: 'pi', threadId: 'a' }]
  const activity = new PowerActivity({
    harnesses: () => [],
    report: async () => {},
    now: () => now,
    background: () => background,
  })
  const release = activity.begin('pi')
  activity.notification('pi', 'turn/started', turn('a', '1'))
  activity.changed()
  assert.equal(total(activity), 3)
  release()
  release()
  activity.notification('pi', 'turn/completed', turn('a', '1'))
  assert.equal(total(activity), 1)
  now += 10000
  activity.changed()
  assert.equal(activity.snapshot().sources[0]?.observedAgoMs, 10000)
  background = []
  activity.changed()
  assert.equal(total(activity), 0)
  activity.close()
})

test('失败核对保留每条旧证据年龄；其他会话新活动不能续旧证据', async () => {
  let now = 1000
  const fake = engine()
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
    now: () => now,
  })
  activity.notification('pi', 'turn/started', turn('old', '1'))
  const oldId = activity.snapshot().sources[0]?.id
  fake.fail()
  now += 30000
  await activity.reconcile()
  activity.notification('pi', 'turn/started', turn('new', '2'))
  now += 15000
  const old = activity.snapshot().sources.find((source) => source.id === oldId)
  assert.equal(old?.unknown, true)
  assert.equal(old?.working, 1)
  assert.equal(old?.observedAgoMs, 45000)
  activity.close()
})

test('成功整份核对修复漏事件，并且核对期间结束的回合不被旧快照复活', async () => {
  const fake = engine()
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  fake.data([thread('a', 'active')])
  await activity.reconnected('pi')
  assert.equal(total(activity), 1)
  fake.hold()
  const pending = activity.reconcile()
  await new Promise((resolve) => setImmediate(resolve))
  activity.notification('pi', 'turn/completed', turn('a', '1'))
  fake.release()
  await pending
  assert.equal(total(activity), 0)
  activity.close()
})

test('空闲的已加载会话不使报告膨胀；已确认后台工作可跨回合结束保持', async () => {
  const fake = engine()
  fake.data([
    ...Array.from({ length: 1000 }, (_, index) => thread(String(index), 'idle')),
    {
      ...thread('background', 'idle'),
      litchBackground: { tasks: [{ status: 'running' }] },
    },
  ])
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  await activity.reconnected('pi')
  assert.equal(activity.snapshot().sources.length, 1)
  assert.equal(total(activity), 1)
  fake.data([])
  await activity.reconcile()
  assert.equal(total(activity), 0)
  activity.close()
})

test('未start不探测，close取消在途连接和所有后续报告', async () => {
  const fake = engine()
  fake.hold()
  const reports: PowerActivityReport[] = []
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async (value) => {
      reports.push(value)
    },
    heartbeatMs: 5,
    probeMs: 5,
  })
  activity.notification('pi', 'turn/started', turn('a', '1'))
  assert.equal(reports.length, 0)
  activity.start()
  await new Promise((resolve) => setImmediate(resolve))
  activity.close()
  const after = reports.length
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.closes(), 1)
  assert.equal(reports.length, after)
})

test('心跳只刷新设备内定时执行数，不刷新未知引擎工作', async () => {
  let now = 1000
  let tasks = 0
  const reports: PowerActivityReport[] = []
  const activity = new PowerActivity({
    harnesses: () => [],
    report: async (value) => {
      reports.push(value)
    },
    now: () => now,
    tasks: () => tasks,
    heartbeatMs: 5,
    probeMs: 100000,
  })
  activity.notification('pi', 'turn/started', turn('a', '1'))
  activity.start()
  await new Promise((resolve) => setImmediate(resolve))
  const oldId = reports.at(-1)?.sources.find((source) => source.working === 1)?.id
  now += 10000
  tasks = 2
  await new Promise((resolve) => setTimeout(resolve, 15))
  const last = reports.at(-1)
  assert.equal(last?.sources.find((source) => source.id === oldId)?.observedAgoMs, 10000)
  assert.equal(last?.sources.find((source) => source.working === 2)?.observedAgoMs, 0)
  activity.close()
})

test('内部核对失败时保留回合和后台证据年龄，不伪造空闲', async () => {
  let now = 1000
  const fake = engine()
  fake.runtimeUnknown()
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
    now: () => now,
  })
  activity.notification('pi', 'turn/started', turn('a', '1'))
  activity.notification('pi', 'litch/thread/background/changed', {
    threadId: 'a',
    tasks: [{ status: 'running' }],
  })
  now += 30000
  fake.data([{ id: 'a', status: { type: 'idle' } }])
  await activity.reconcile()
  assert.equal(total(activity), 2)
  assert.equal(activity.snapshot().sources.find((source) => source.working > 0)?.unknown, true)
  assert.equal(
    activity.snapshot().sources.find((source) => source.working > 0)?.observedAgoMs,
    30000,
  )
  now += 30000
  await activity.reconcile()
  assert.equal(
    activity.snapshot().sources.find((source) => source.working > 0)?.observedAgoMs,
    60000,
  )
  activity.close()
})

test('首次核对前和失败快照不完整，明确结束的零来源仍报告；成功核对后完整', async () => {
  const fake = engine()
  fake.hold()
  const reports: PowerActivityReport[] = []
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async (value) => {
      reports.push(value)
    },
  })
  activity.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reports[0]?.complete, false)
  activity.notification('pi', 'turn/started', turn('a', '1'))
  activity.notification('pi', 'turn/completed', turn('a', '1'))
  assert.equal(
    activity.snapshot().sources.some((source) => source.working === 0 && !source.unknown),
    true,
  )
  fake.release()
  await activity.reconcile()
  assert.equal(activity.snapshot().complete, true)
  fake.fail()
  fake.release()
  // initialize 会失败，不会等住列表。
  await activity.reconnected('pi')
  assert.equal(activity.snapshot().complete, false)
  activity.close()
})

test('无人客户端的子线程不被顶层列表漏项清掉；后台空字段确认已结束', async () => {
  const fake = engine()
  fake.hidden([{ id: 'child', status: { type: 'active' } }])
  fake.data([{ id: 'parent', status: { type: 'idle' } }])
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  activity.notification('pi', 'litch/thread/background/changed', {
    threadId: 'parent',
    tasks: [{ status: 'running' }],
  })
  await activity.reconnected('pi')
  assert.equal(total(activity), 1)
  assert.equal(activity.snapshot().complete, true)
  fake.hidden([{ id: 'child', status: { type: 'idle' } }])
  await activity.reconcile()
  assert.equal(total(activity), 0)
  activity.close()
})

test('启动恢复一次，此后周期不发现新会话；明确重连才恢复新增工作', async () => {
  const fake = engine()
  fake.hidden([{ id: 'first', status: { type: 'active' } }])
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  activity.start()
  await activity.reconcile()
  assert.equal(total(activity), 1)
  fake.hidden([
    { id: 'first', status: { type: 'idle' } },
    { id: 'external', status: { type: 'active' } },
  ])
  await activity.reconcile()
  assert.equal(total(activity), 0)
  const calls = fake.methods.length
  await activity.reconcile()
  assert.equal(fake.methods.length, calls)
  assert.equal(fake.queries.filter((query) => query.threadIds === undefined).length, 1)
  await activity.reconnected('pi')
  assert.equal(total(activity), 1)
  assert.equal(fake.queries.filter((query) => query.threadIds === undefined).length, 2)
  assert.equal(fake.methods.includes('thread/list'), false)
  activity.close()
})

test('启动恢复失败后首次可达补恢复，成功后短连接不再查询', async () => {
  const fake = engine()
  fake.fail()
  fake.hidden([{ id: 'active', status: { type: 'active' } }])
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  activity.start()
  await activity.reconcile()
  assert.equal(activity.needsRecovery('pi'), true)
  assert.equal(activity.snapshot().complete, false)
  fake.recover()
  if (activity.needsRecovery('pi')) await activity.reconnected('pi')
  assert.equal(activity.needsRecovery('pi'), false)
  assert.equal(activity.snapshot().complete, true)
  assert.equal(total(activity), 1)
  const calls = fake.methods.length
  if (activity.needsRecovery('pi')) await activity.reconnected('pi')
  assert.equal(fake.methods.length, calls)
  activity.close()
})

test('恢复在途再重连时，旧轮成功不能把失败的新轮标成已恢复', async () => {
  const fake = engine()
  fake.hold()
  const activity = new PowerActivity({
    harnesses: () => [{ id: 'pi', running: true, connect: fake.connect }],
    report: async () => {},
  })
  activity.start()
  await new Promise((resolve) => setImmediate(resolve))
  const recovering = activity.reconnected('pi')
  fake.release()
  fake.fail()
  await recovering
  assert.equal(activity.needsRecovery('pi'), true)
  assert.equal(activity.snapshot().complete, false)
  activity.close()
})
