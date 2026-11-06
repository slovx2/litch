import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServiceRestarter } from '../src/device/service-restart.mjs'
import type { RemoteStopResult } from '../src/model-service.mjs'
import { fakeClock, settle } from './helpers.mjs'

const service = { version: '1.0.0', pid: 1, startedAt: 1, root: '/adapter', detached: true }
const busy: RemoteStopResult = {
  result: 'busy',
  busy: [
    { reason: 'activeTurns', harnesses: ['pi'], count: 0 },
    { reason: 'deviceProcesses', harnesses: [], count: 1 },
    { reason: 'tasks', harnesses: [], count: 1 },
  ],
}
function setup(results: RemoteStopResult[]) {
  const time = fakeClock()
  const stops: boolean[] = []
  let reconnected = 0
  const restart = createServiceRestarter({
    clock: time.clock,
    stop: async (idle) => {
      stops.push(idle)
      return results.shift() ?? { result: 'stopped' }
    },
    changed() {},
    reconnect: () => {
      reconnected++
    },
    sessions: () => [{ id: 's1', title: 'test', running: true, background: 0 }],
    interrupted() {},
  })
  const seen = { online: true, full: true, service, failure: null, upgrading: false }
  restart.seen(seen)
  return { time, stops, restart, seen, reconnected: () => reconnected }
}

test('本机闲时自动升级立即重连，忙时复用全部忙碌原因并等空闲', async () => {
  const w = setup([busy, { result: 'stopped' }])
  w.restart.run('auto')
  await settle()
  assert.equal(w.restart.view().autoUpgrade, true)
  assert.deepEqual(w.restart.view().phase, { step: 'busy', busy: busy.busy })
  w.time.advance(30_000)
  await settle()
  assert.deepEqual(w.stops, [true, true])
  assert.equal(w.reconnected(), 1)
  assert.equal(w.restart.view().autoUpgrade, false)
  w.restart.dispose()
})

test('取消本机等待后不再重试；强制仍走现有停止链路', async () => {
  const w = setup([busy])
  w.restart.run('auto')
  await settle()
  w.restart.run('cancel')
  w.time.advance(60_000)
  await settle()
  assert.deepEqual(w.stops, [true])
  assert.equal(w.restart.view().autoUpgrade, false)
  w.restart.run('force')
  await settle()
  assert.deepEqual(w.stops, [true, false])
  w.restart.dispose()
})

test('本机排队遇断线保留等待，重连后继续，失败结束等待', async () => {
  const w = setup([busy, { result: 'failed', said: 'denied' }])
  w.restart.run('auto')
  await settle()
  w.restart.seen({ ...w.seen, online: false })
  w.time.advance(30_000)
  assert.deepEqual(w.stops, [true])
  w.restart.seen(w.seen)
  w.time.advance(30_000)
  await settle()
  assert.equal(w.restart.view().phase.step, 'failed')
  assert.equal(w.restart.view().autoUpgrade, false)
  w.restart.dispose()
})

test('排队期间服务变为外部管理：不抛定时器异常，不擅自停止，仍可取消', async () => {
  const w = setup([busy])
  w.restart.run('auto')
  await settle()
  w.restart.seen({ ...w.seen, service: { ...service, detached: false } })
  w.time.advance(60_000)
  await settle()
  assert.deepEqual(w.stops, [true])
  w.restart.run('cancel')
  assert.equal(w.restart.view().autoUpgrade, false)
  w.restart.dispose()
})
