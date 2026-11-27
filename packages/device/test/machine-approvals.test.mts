import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  MACHINE_APPROVAL_METHOD as M,
  MACHINE_APPROVALS,
  MACHINE_APPROVAL_NOTIFICATION as N,
} from '../../protocol/src/machine-approvals.mjs'
import { parseBackgroundCompletion } from '../../protocol/src/native-background-wake.mjs'
import type { ClientToolPeer } from '../src/client-tools.mjs'
import { DeviceMachineApprovals } from '../src/machine-approvals.mjs'
import type { Frame } from '../src/wire.mjs'

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

test('签名扩展按连接投影，只转给发卡 Mac，设备自身不会批准', async (t) => {
  const db = new DatabaseSync(':memory:')
  const forwarded: Frame[] = []
  const methods: string[] = []
  const executor = {
    ready: true,
    declares: () => true,
    deliverClientTool(_harness: string, frame: Frame, reply: (frame: Frame) => void) {
      forwarded.push(frame)
      reply({ id: frame.id ?? null, result: { accepted: false } })
      return frame.id
    },
  } as unknown as ClientToolPeer & { declares(): boolean; announce(): void }
  const legacy = { declares: (name: string): boolean => name === MACHINE_APPROVALS, announce() {} }
  const signed = { declares: () => true, announce() {} }
  const jobs = new DeviceMachineApprovals({
    db,
    source: (from) => from === executor,
    allowed: () => true,
    announce: (method) => methods.push(method),
    task: () => assert.fail('设备不能代替执行 Mac 开始操作'),
    deliver: async () => true,
    log: () => {},
  })
  t.after(() => {
    jobs.shutdown()
    db.close()
  })
  const review = {
    desktopId: randomUUID(),
    nonce: randomUUID(),
    version: 1,
    details: '{"command":"pwd"}',
    snapshotHash: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
  }
  const card = {
    id: randomUUID(),
    threadId: 'line',
    callId: 'call',
    turnId: 'turn',
    desktop: 'Mac',
    action: 'exec',
    target: 'pwd',
    cwd: '/work',
    expiresAt: Date.now() + 60_000,
    review,
  }
  jobs.call(executor, true, M.open, card)
  assert.deepEqual(methods, [N.changed, N.changedSigned, N.changedControls])
  const viewer = (capabilities: typeof legacy) => capabilities as unknown as typeof executor
  const list = (peer: typeof legacy) =>
    jobs.call(viewer(peer), true, M.list, {}) as { cards: Array<{ review?: unknown }> }
  assert.equal(list(legacy).cards[0]?.review, undefined)
  assert.deepEqual(list(signed).cards[0]?.review, review)
  const proof = {
    id: card.id,
    threadId: card.threadId,
    expiresAt: card.expiresAt,
    desktopId: review.desktopId,
    nonce: review.nonce,
    version: review.version,
    payloadHash: review.payloadHash,
    phoneId: 'f83898df0bef57a4',
    decision: 'once',
    signature: 'B'.repeat(86) + '==',
  }
  assert.deepEqual(jobs.call(viewer(legacy), true, M.answer, proof), { accepted: false })
  assert.deepEqual(jobs.call(viewer(signed), true, M.answer, { ...proof, signature: undefined }), {
    accepted: false,
  })
  assert.deepEqual(
    jobs.call(viewer(signed), true, M.answer, { ...proof, expiresAt: Date.now() - 1 }),
    { accepted: false },
  )
  assert.equal(forwarded.length, 0)
  assert.deepEqual(await jobs.call(viewer(signed), true, M.answer, proof), { accepted: false })
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0]?.method, M.verify)
  assert.deepEqual(forwarded[0]?.params, proof)
  assert.equal(list(signed).cards.length, 1, '未获 Mac 批准时仍待批')
})
