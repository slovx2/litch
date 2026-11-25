import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  MACHINE_APPROVAL_METHOD as M,
  MACHINE_APPROVAL_NOTIFICATION as N,
} from '../../protocol/src/machine-approvals.mjs'
import { parseBackgroundCompletion } from '../../protocol/src/native-background-wake.mjs'
import type { ClientToolPeer } from '../src/client-tools.mjs'
import { DeviceMachineApprovals } from '../src/machine-approvals.mjs'

test('只有选定桌面能提交和开始，后台任务可停止，结果送回原会话', async (t) => {
  const db = new DatabaseSync(':memory:')
  const taskStatus: string[] = []
  const events: string[] = []
  const stops: string[] = []
  const peer = {
    declares: () => true,
    announce: (method: string) => stops.push(method),
  } as unknown as ClientToolPeer & { declares(): boolean; announce(method: string): void }
  const mobile = { ...peer }
  const jobs = new DeviceMachineApprovals({
    db,
    source: (from, thread, call) => from === peer && thread === 'line' && call === 'original',
    allowed: () => true,
    announce: () => {},
    task: (thread, task) => {
      assert.equal(thread, 'line')
      taskStatus.push(task.status)
    },
    deliver: async (thread, text, _id, dispatched) => {
      assert.equal(thread, 'line')
      const event = parseBackgroundCompletion(text)?.events[0]
      assert.equal(event?.originalTurnId, 'turn')
      events.push(event?.output ?? '')
      dispatched()
      return true
    },
    log: () => {},
  })
  t.after(() => {
    jobs.shutdown()
    db.close()
  })
  const key = { id: randomUUID(), threadId: 'line' }
  const draft = {
    ...key,
    callId: 'original',
    turnId: 'turn',
    action: 'exec',
    target: 'pwd',
    cwd: '/work',
    desktop: 'Mac',
    expiresAt: Date.now() + 120_000,
  }
  assert.throws(() => jobs.call(mobile, true, M.open, draft), /unauthorized/)
  jobs.call(peer, true, M.open, draft)
  assert.deepEqual(taskStatus, [])
  assert.throws(() => jobs.call(mobile, true, M.start, key), /selected desktop/)
  assert.throws(() => jobs.call(mobile, false, M.list, {}), /administrator/)
  assert.throws(() => jobs.call(mobile, true, 'litch/machineApproval/answer', key))
  jobs.call(peer, true, M.start, key)
  assert.deepEqual(jobs.call(mobile, true, M.list, {}), { cards: [] })
  assert.throws(() => jobs.call(peer, true, M.start, key), /no longer/)
  jobs.call(mobile, true, M.stop, key)
  jobs.call(mobile, true, M.stop, key)
  assert.deepEqual(stops, [N.stop])
  jobs.call(peer, true, M.finish, { ...key, outcome: 'stopped', text: 'partial output' })
  assert.deepEqual(taskStatus, ['running', 'stopped'])
  for (let i = 0; i < 30 && !events.length; i++) await delay(10)
  assert.deepEqual(events, ['partial output'])
  assert.throws(() => jobs.call(peer, true, M.start, key), /no longer/)
  const expiring = { ...draft, id: randomUUID(), expiresAt: Date.now() + 30 }
  jobs.call(peer, true, M.open, expiring)
  for (let i = 0; i < 30 && events.length === 1; i++) await delay(10)
  assert.deepEqual(jobs.call(mobile, true, M.list, {}), { cards: [] })
  assert.match(events[1] ?? '', /expired.*not run/)
  assert.throws(() => jobs.call(peer, true, M.start, expiring), /no longer/)
  assert.deepEqual(taskStatus, ['running', 'stopped'], '到期待批没有建后台任务')
})
