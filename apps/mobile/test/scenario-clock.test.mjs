import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionStore } from '../src/core/session-store.ts'
import { createTestClock } from '../src/shell/test-clock.ts'
import { mockChannel, until } from './helpers.mjs'

test('受控计时器只按显式步长触发，取消后不执行', () => {
  const time = createTestClock(100)
  const seen = []
  time.clock.setTimer(() => seen.push(time.clock.now()), 20)
  const cancel = time.clock.setTimer(() => seen.push('cancelled'), 10)
  cancel()
  time.advance(19)
  assert.deepEqual(seen, [])
  time.advance(1)
  assert.deepEqual(seen, [120])
  assert.throws(() => time.advance(-1))
})

test('后台完成、目标续跑和提案过期只由场景时钟释放，流式回答无需拨钟', async (t) => {
  const time = createTestClock(Date.now())
  const mock = mockChannel({ chunkMs: 0, scenarioClock: time.clock })
  t.after(() => mock.close())
  const watch = (deviceId, sessionId) => {
    const store = new SessionStore(mock.channel, deviceId, sessionId)
    store.start()
    t.after(() => store.stop())
    return store
  }
  const target = { deviceId: 'build', sessionId: 'b6' }
  const goal = watch(target.deviceId, target.sessionId)
  await until(() => goal.getMeta())
  await mock.channel.command('session.goal.set', { ...target, objective: 'controlled' })
  await until(() => goal.getMeta().goal?.status === 'active')
  await mock.channel.command('session.goal.set', { ...target, status: 'paused' })
  time.advance(1500)
  await until(() => goal.getMeta().goal?.status === 'paused')
  await mock.channel.command('session.goal.set', { ...target, status: 'active' })
  for (let i = 1; i <= 3; i++) {
    time.advance(1500)
    await until(() =>
      i === 3 ? goal.getMeta().goal === null : goal.getMeta().goal?.tokensUsed === i * 1200,
    )
  }
  await until(() => goal.getMeta().goal === null)

  let background = null
  const stopSidebar = mock.channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        background = data.sessions.find((s) => s.id === 's3')?.background
      },
      delta(ops) {
        for (const op of ops)
          if (op.op === 'session.upsert' && op.session.id === 's3')
            background = op.session.background
      },
    },
  )
  t.after(stopSidebar)
  const local = { deviceId: 'local', sessionId: 's3' }
  const store = watch(local.deviceId, local.sessionId)
  await until(() => store.getMeta())
  await mock.channel.command('session.send', { ...local, text: 'propose a sub-session' })
  const proposals = await until(() => store.getProposals()?.length === 3 && store.getProposals())
  assert.deepEqual(
    proposals.map((p) => p.id),
    ['e2e-pr1', 'e2e-pr2', 'e2e-pr3'],
  )
  assert.ok(proposals.every((p) => p.status === 'pending'))
  time.advance(8000)
  await until(() => store.getProposals()[1].status === 'expired')
  assert.equal(store.getProposals()[0].status, 'pending')
  await until(() => !store.getMeta().running)
  await mock.channel.command('session.send', { ...local, text: 'start two background tasks' })
  await until(() => !store.getMeta().running)
  await until(() => background?.running === 2)
  time.advance(4000)
  await until(() => background?.running === 1 && !store.getMeta().running)
  time.advance(5000)
  await until(() => background?.running === 0)
})
