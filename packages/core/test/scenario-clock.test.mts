import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  reduceSession,
  type SessionSummary,
  type SessionView,
  serveChannel,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('场景被冻结时真实计时器走一分钟也不结束任务、续跑目标或过期提案', async (t) => {
  const runtime = fakeClock()
  const scenario = fakeClock()
  const [ui, core] = createPortPair()
  const unserve = serveChannel(
    core,
    createMockCore({
      clock: runtime.clock,
      scenarioClock: scenario.clock,
      chunkMs: 0,
    }),
    { clock: runtime.clock },
  )
  const channel = connectChannel(ui)
  t.after(() => {
    channel.close()
    unserve()
  })
  const rows = new Map<string, SessionSummary>()
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        for (const row of data.sessions) rows.set(row.id, row)
      },
      delta(ops) {
        for (const op of ops) if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
      },
    },
  )
  const watch = (deviceId: string, sessionId: string) => {
    const state = { view: null as SessionView | null }
    channel.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot(data) {
          state.view = structuredClone(data)
        },
        delta(ops) {
          if (state.view) for (const op of ops) reduceSession(state.view, structuredClone(op))
        },
      },
    )
    return state
  }
  const background = watch('local', 's3')
  const goal = watch('build', 'b6')
  const proposals = watch('local', 's4')
  await settle()
  const goalTurns = goal.view?.turns.length
  await channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's3',
    text: 'start two background tasks',
  })
  await channel.command('session.goal.set', {
    deviceId: 'build',
    sessionId: 'b6',
    objective: 'controlled',
  })
  await channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's4',
    text: 'propose a sub-session',
  })
  runtime.advance(60_000)
  await settle()
  assert.equal(rows.get('s3')?.background?.running, 2)
  assert.equal(background.view?.turns.at(-1)?.status, 'completed')
  assert.equal(goal.view?.turns.length, goalTurns)
  assert.deepEqual(
    proposals.view?.proposals.map((p) => p.status),
    ['pending', 'pending', 'pending'],
  )
  scenario.advance(8000)
  await settle()
  runtime.advance(60_000)
  await settle()
  assert.equal(rows.get('s3')?.background?.running, 1)
  assert.equal(goal.view?.turns.length, (goalTurns ?? 0) + 1)
  assert.equal(proposals.view?.proposals[1]?.status, 'expired')
  scenario.advance(1000)
  runtime.advance(50)
  await settle()
  assert.equal(rows.get('s3')?.background?.running, 0)
})
