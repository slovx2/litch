import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineLink } from '../src/engine-link.mjs'
import { RecoveryActions } from '../src/recovery-actions.mjs'
import { TurnRecoveryObserver } from '../src/turn-recovery.mjs'

async function rig(slowReads = 0) {
  let now = 1_800_000_000_000
  const observer = new TurnRecoveryObserver({
    now: () => now,
    announce() {},
    check: async () => ({ thread: { status: { type: 'active' } } }),
  })
  observer.observe('codex', 'turn/started', { threadId: 't', turn: { id: 'a', startedAt: now } })
  now += 300000
  await observer.tick()
  let status = 'inProgress',
    id = 'a',
    fail = false,
    closed = 0
  let stopping = false
  let onFlags = () => {}
  let onStop = () => {}
  const calls: { method: string; params: any; at: number }[] = []
  const link = {
    close: () => {
      closed++
    },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params, at: Date.now() })
      if (method === 'thread/read') {
        const full = (params as { includeTurns: boolean }).includeTurns
        if (!full && stopping && --slowReads <= 0) status = 'interrupted'
        return {
          thread: {
            get status() {
              onFlags()
              return { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: [] }
            },
            ...(full ? { turns: [{ id, status }] } : {}),
          },
        }
      }
      if (method === 'turn/interrupt') {
        if (fail) throw new Error('timeout')
        stopping = true
        if (!slowReads) status = 'interrupted'
        onStop()
      }
      return {}
    },
  } as unknown as EngineLink
  const actions = new RecoveryActions(observer, async () => link)
  return {
    actions,
    observer,
    calls,
    ref: { harness: 'codex', threadId: 't', turnId: 'a', text: '核对已有步骤后继续' },
    fail: () => {
      fail = true
    },
    change: () => {
      id = 'new'
    },
    closed: () => closed,
    onFlags: (fn: () => void) => {
      onFlags = fn
    },
    onStop: (fn: () => void) => {
      onStop = fn
    },
  }
}

test('显式继续先中断并读到 interrupted，再发送一次继续请求', async () => {
  const r = await rig()
  await r.actions.continue(r.ref)
  assert.deepEqual(
    r.calls.map((c) => c.method),
    ['thread/read', 'turn/interrupt', 'thread/read', 'thread/read', 'turn/start'],
  )
  assert.equal(r.calls.at(-1)?.params.input[0].text, r.ref.text)
  assert.equal(r.closed(), 1)
  r.observer.close()
})

test('中断超时、回合变化、进展恢复后均不再发新回合', async () => {
  for (const mode of ['timeout', 'changed', 'progress']) {
    const r = await rig()
    if (mode === 'timeout') r.fail()
    if (mode === 'changed') r.change()
    if (mode === 'progress')
      r.observer.observe('codex', 'item/agentMessage/delta', {
        threadId: 't',
        turnId: 'a',
        delta: '已恢复',
      })
    await assert.rejects(r.actions.continue(r.ref))
    assert.ok(!r.calls.some((c) => c.method === 'turn/start'), mode)
    r.observer.close()
  }
})

test('同一回合重复点击只执行一次', async () => {
  const r = await rig()
  const first = r.actions.continue(r.ref)
  await assert.rejects(r.actions.continue(r.ref))
  await first
  assert.equal(r.calls.filter((c) => c.method === 'turn/start').length, 1)
  r.observer.close()
})

test('检查快照后、发中断前恢复进展，不得中断正常回合', async () => {
  const r = await rig()
  try {
    r.onFlags(() =>
      r.observer.observe('codex', 'item/agentMessage/delta', {
        threadId: 't',
        turnId: 'a',
        delta: '已恢复',
      }),
    )
    await assert.rejects(r.actions.continue(r.ref), /turn changed/i)
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['thread/read'],
    )
  } finally {
    r.observer.close()
  }
})

test('中断确认用轻量状态300–500ms退避，完整历史只在开始和终态各读一次', async () => {
  const r = await rig(3)
  try {
    await r.actions.continue(r.ref)
    const reads = r.calls.filter((c) => c.method === 'thread/read')
    assert.deepEqual(
      reads.map((c) => c.params.includeTurns),
      [true, false, false, false, true],
    )
    const light = reads.filter((c) => !c.params.includeTurns)
    const [first, second, third] = light
    assert.ok(first && second && third)
    assert.ok(second.at - first.at >= 280)
    assert.ok(third.at - second.at >= 480)
    assert.equal(r.calls.filter((c) => c.method === 'turn/start').length, 1)
  } finally {
    r.observer.close()
  }
})

test('状态离开active后仍完整核对旧回合，新回合已经出现则不发继续', async () => {
  const r = await rig()
  try {
    r.onStop(r.change)
    await assert.rejects(r.actions.continue(r.ref), /different turn/)
    assert.equal(
      r.calls.some((c) => c.method === 'turn/start'),
      false,
    )
    assert.equal(
      r.calls.filter((c) => c.method === 'thread/read' && c.params.includeTurns).length,
      2,
    )
  } finally {
    r.observer.close()
  }
})
