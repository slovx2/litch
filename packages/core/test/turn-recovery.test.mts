import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { agentText, thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const notice = {
  harness: 'codex',
  threadId: 'a',
  turnId: 't1',
  recovery: { reason: 'wake', observedAt: 1000, lastProgressAt: 0 },
}
function setup(read: () => unknown = () => ({ notices: [notice] })) {
  return deviceWorld(
    [
      harness('codex', {
        threads: [
          thread({
            id: 'a',
            status: { type: 'active', activeFlags: [] },
            turns: [turn('t1', [agentText('answer', '已有内容')], { status: 'inProgress' })],
          }),
        ],
      }),
    ],
    {
      prepare: (device) => {
        device.extensions.push('turnRecovery')
      },
      extra: {
        'litch/device/recovery/read': read,
        'litch/device/recovery/continue': () => ({}),
        'litch/device/recovery/dismiss': () => ({}),
      },
    },
  )
}

test('打开回合补读恢复提醒；等待与继续均转到执行设备，进展后拒绝旧操作', async () => {
  const w = setup()
  w.core.start()
  await settle()
  const session = watchSession(w.core)
  await settle()
  assert.equal(session.seen.view?.turns[0]?.recovery?.reason, 'wake')
  const turnId = session.seen.view?.turns[0]?.id
  assert.ok(turnId)
  await w.command('session.dismissRecovery', { sessionId: 'a', turnId })
  assert.deepEqual(w.sent('litch/device/recovery/dismiss'), [
    { harness: 'codex', threadId: 'a', turnId: 't1' },
  ])
  await w.command('session.recover', { sessionId: 'a', turnId, text: '核对已有步骤后继续' })
  assert.equal(w.sent('litch/device/recovery/continue')[0]?.turnId, 't1')
  w.peer.last().notify('item/agentMessage/delta', {
    threadId: 'a',
    turnId: 't1',
    itemId: 'answer',
    delta: '恢复',
  })
  await settle()
  assert.equal(session.seen.view?.turns[0]?.recovery, null)
  await assert.rejects(w.command('session.recover', { sessionId: 'a', turnId, text: '继续' }))
  w.core.stop()
})

test('补读迟到时不能覆盖已经恢复的流', async () => {
  let reply: (value: unknown) => void = () => {}
  const w = setup(
    () =>
      new Promise((resolve) => {
        reply = resolve
      }),
  )
  w.core.start()
  await settle()
  const session = watchSession(w.core)
  await settle()
  w.peer.last().notify('item/agentMessage/delta', {
    threadId: 'a',
    turnId: 't1',
    itemId: 'answer',
    delta: '恢复',
  })
  await settle()
  reply({ notices: [notice] })
  await settle()
  assert.equal(session.seen.view?.turns[0]?.recovery ?? null, null)
  w.core.stop()
})
