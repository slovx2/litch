import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecoveryNotice } from '../../protocol/src/turn-recovery.mjs'
import { TurnRecoveryObserver } from '../src/turn-recovery.mjs'

const epoch = 1_800_000_000_000
function rig() {
  let now = epoch
  const notices: RecoveryNotice[] = []
  let checks = 0
  let check: () => Promise<unknown> = async () => ({
    thread: { status: { type: 'active', activeFlags: [] } },
  })
  const observer = new TurnRecoveryObserver({
    now: () => now,
    announce: (n) => notices.push(structuredClone(n)),
    check: (_harness, _thread, includeTurns) => {
      if (!includeTurns) checks++
      return check()
    },
  })
  const event = (method: string, params: Record<string, unknown> = {}) =>
    observer.observe('codex', method, { threadId: 't', turnId: 'a', ...params })
  const start = () => event('turn/started', { turn: { id: 'a', startedAt: now } })
  return {
    observer,
    notices,
    event,
    start,
    advance: (ms: number) => {
      now += ms
    },
    checks: () => checks,
    check: (fn: typeof check) => {
      check = fn
    },
    now: () => now,
  }
}

test('五分钟无进展才提醒；重试、重复开始和快照不续期，新增内容撤销', async () => {
  const r = rig()
  await r.observer.tick()
  assert.equal(r.checks(), 0)
  r.start()
  r.advance(299999)
  await r.observer.tick()
  assert.equal(r.checks(), 0)
  r.start()
  r.event('error', { willRetry: true })
  r.observer.snapshot('codex', { id: 't', turns: [{ id: 'a', status: 'inProgress' }] })
  r.advance(1)
  await r.observer.tick()
  assert.equal(r.notices.at(-1)?.recovery?.reason, 'idle')
  await r.observer.tick()
  assert.equal(r.checks(), 1)
  r.event('item/agentMessage/delta', { delta: '恢复' })
  assert.equal(r.notices.at(-1)?.recovery, null)
  r.advance(300000)
  await r.observer.tick()
  assert.equal(r.checks(), 2)
  r.observer.close()
})

test('执行设备新唤醒后30秒提醒，历史标记、重复状态和唤醒后新回合不触发', async () => {
  const r = rig()
  r.observer.resumed({ supported: true, generation: 'g', sequence: 1, resumedAt: epoch - 1000 })
  r.start()
  r.advance(1000)
  const wake = { supported: true, generation: 'g', sequence: 2, resumedAt: r.now() }
  r.observer.resumed(wake)
  r.advance(29999)
  await r.observer.tick()
  assert.equal(r.checks(), 0)
  r.observer.resumed(wake)
  r.advance(1)
  await r.observer.tick()
  assert.equal(r.notices.at(-1)?.recovery?.reason, 'wake')
  r.observer.dismiss('codex', 't', 'a')
  await r.observer.tick()
  assert.equal(r.checks(), 1)
  r.event('turn/completed', { turn: { id: 'a', status: 'interrupted' } })
  r.start()
  r.observer.resumed(wake)
  r.advance(30000)
  await r.observer.tick()
  assert.equal(r.checks(), 1)
  r.observer.close()
})

test('审批和长工具不当作模型停流；回合切换与迟到的探测不能复活旧提醒', async () => {
  const r = rig()
  r.start()
  r.event('item/started', { item: { id: 'tool', type: 'commandExecution' } })
  r.check(async () => ({
    thread: {
      id: 't',
      status: { type: 'active' },
      turns: [
        {
          id: 'a',
          status: 'inProgress',
          items: [{ id: 'tool', type: 'commandExecution', status: 'inProgress' }],
        },
      ],
    },
  }))
  r.advance(400000)
  await r.observer.tick()
  assert.equal(r.checks(), 1, '长工具也按较长间隔复查')
  assert.equal(r.observer.list().length, 0)
  r.event('item/completed', { item: { id: 'tool', type: 'commandExecution' } })
  r.event('thread/status/changed', {
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  })
  r.check(async () => ({
    thread: {
      id: 't',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      turns: [
        {
          id: 'a',
          status: 'inProgress',
          items: [{ id: 'tool', type: 'commandExecution', status: 'completed' }],
        },
      ],
    },
  }))
  r.advance(400000)
  await r.observer.tick()
  assert.equal(r.checks(), 2)
  r.event('thread/status/changed', { status: { type: 'active', activeFlags: [] } })
  r.advance(300000)
  let release: (value: unknown) => void = () => {}
  r.check(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = r.observer.tick()
  r.event('turn/completed', { turn: { id: 'a', status: 'completed' } })
  r.event('turn/started', { turn: { id: 'b', startedAt: r.now() } })
  release({ thread: { status: { type: 'idle' } } })
  await pending
  r.advance(300000)
  r.check(async () => ({ thread: { status: { type: 'active' } } }))
  await r.observer.tick()
  assert.equal(r.notices.at(-1)?.turnId, 'b')
  assert.equal(r.notices.filter((n) => n.turnId === 'a').length, 0)
  r.observer.close()
})

test('探测不可达只提示，不中断；有新进展的迟到失败不能覆盖恢复', async () => {
  const r = rig()
  r.start()
  r.advance(300000)
  r.check(async () => {
    throw new Error('offline')
  })
  await r.observer.tick()
  assert.equal(r.notices.at(-1)?.recovery?.reason, 'unresponsive')
  assert.equal(r.observer.eligible('codex', 't', 'a'), true)
  r.event('item/reasoning/summaryTextDelta', { delta: '新进展' })
  assert.equal(r.observer.eligible('codex', 't', 'a'), false)
  r.observer.close()
})

test('检查最多四条并发，迟到的空闲快照不能删除已恢复的回合', async () => {
  let now = epoch,
    active = 0,
    peak = 0,
    total = 0
  const gates: (() => void)[] = []
  const observer = new TurnRecoveryObserver({
    now: () => now,
    announce() {},
    check: async (_harness, _thread, includeTurns) => {
      if (includeTurns) return { thread: { status: { type: 'active', activeFlags: [] } } }
      total++
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => {
        gates.push(resolve)
      })
      active--
      return { thread: { status: { type: 'active', activeFlags: [] } } }
    },
  })
  for (let n = 0; n < 9; n++)
    observer.observe('pi', 'turn/started', { threadId: `t${n}`, turn: { id: 'a' } })
  now += 300000
  const pending = observer.tick()
  assert.equal(active, 4)
  while (total < 9 || active) {
    for (const resolve of gates.splice(0)) resolve()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await pending
  assert.equal(peak, 4)
  assert.equal(observer.list().length, 9)
  observer.close()

  const r = rig()
  r.start()
  r.advance(300000)
  let release: (value: unknown) => void = () => {}
  r.check(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const reading = r.observer.tick()
  r.event('item/agentMessage/delta', { delta: '恢复' })
  release({ thread: { status: { type: 'idle' } } })
  await reading
  r.advance(300000)
  r.check(async () => ({ thread: { status: { type: 'active' } } }))
  await r.observer.tick()
  assert.equal(r.observer.list().length, 1, '新进展后的回合仍由观察器跟踪')
  r.observer.close()
})
