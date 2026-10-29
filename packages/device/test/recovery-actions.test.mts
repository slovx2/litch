import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineLink } from '../src/engine-link.mjs'
import { RecoveryActions } from '../src/recovery-actions.mjs'
import { TurnRecoveryObserver } from '../src/turn-recovery.mjs'

async function rig() {
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
  const calls: { method: string; params: any }[] = []
  const link = {
    close: () => {
      closed++
    },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'thread/read') return { thread: { turns: [{ id, status }] } }
      if (method === 'turn/interrupt') {
        if (fail) throw new Error('timeout')
        status = 'interrupted'
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
  }
}

test('显式继续先中断并读到 interrupted，再发送一次继续请求', async () => {
  const r = await rig()
  await r.actions.continue(r.ref)
  assert.deepEqual(
    r.calls.map((c) => c.method),
    ['thread/read', 'turn/interrupt', 'thread/read', 'turn/start'],
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
