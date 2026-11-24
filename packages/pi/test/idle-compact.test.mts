import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  IDLE_COMPACT_READ,
  MANAGER_IDLE_COMPACT_EXTENSION,
} from '../../protocol/src/manager-idle-compact.mjs'
import { approvalHarness } from './approval-harness.mjs'

// 设备空闲压缩用的 Pi 入口：只对声明了扩展的连接开放探测和带快照的压缩，快照对不上就不压，
// 压了就交回回合号；压缩回合不算普通回合。真实 Pi SDK 加回环上的假模型。

async function setup() {
  const h = await approvalHarness({
    approvals: false,
    prepare: async (agentDir) => {
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'gate',
          defaultModel: 'gate',
          retry: { enabled: false },
          compaction: { keepRecentTokens: 0 },
        }),
      )
    },
  })
  const device = await h.connect('device', [MANAGER_IDLE_COMPACT_EXTENSION])
  const plain = await h.connect('desktop')
  const threadId = (await device.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
  return { h, device, plain, threadId }
}

test('探测与带快照压缩：未声明的连接拒绝，快照不一致拒绝，一致则压缩并交回回合号', async () => {
  const { h, device, plain, threadId } = await setup()
  try {
    assert.equal((await plain.call(IDLE_COMPACT_READ, { threadId })).error?.code, -32601)
    h.steps.push({ text: '第一轮回答', promptTokens: 200 })
    const turnId = (
      await device.ok('turn/start', { threadId, input: [{ type: 'text', text: '头一轮 OLD-1' }] })
    ).turn.id
    assert.equal((await device.completed(turnId)).status, 'completed')
    const snapshot = (await device.call(IDLE_COMPACT_READ, { threadId })).result
    assert.equal(snapshot.idle, true)
    assert.equal(snapshot.lastTurnId, turnId)
    assert.equal(typeof snapshot.lastTurnActivityAt, 'number')
    assert.equal(snapshot.usageTurnId, turnId)
    assert.equal(snapshot.usedTokens, 205)
    assert.equal(snapshot.windowTokens, 32_000)

    const unattended = { threadId, litchIdleCompact: snapshot }
    assert.equal((await plain.call('thread/compact/start', unattended)).error?.code, -32601)
    const stale = await device.call('thread/compact/start', {
      threadId,
      litchIdleCompact: { ...snapshot, usedTokens: 1 },
    })
    assert.equal(stale.error?.code, -32009, JSON.stringify(stale))

    h.steps.push({ text: '摘要 SUMMARY-IDLE' }, { text: '摘要 SUMMARY-IDLE' })
    const sent = device.messages.length
    const reply = await device.call('thread/compact/start', unattended)
    assert.equal(typeof reply.result?.turnId, 'string', JSON.stringify(reply))
    const index = device.messages.indexOf(reply)
    const started = await device.until(
      '压缩回合开始',
      (m: any) => m.method === 'turn/started' && device.messages.indexOf(m) >= sent,
    )
    assert.equal(started.params.turn.id, reply.result.turnId)
    assert.ok(device.messages.indexOf(started) > index, '回合开始的通知排在应答之后')
    const turn = await device.completed(reply.result.turnId)
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert.deepEqual(
      turn.items.map((item: any) => item.type),
      ['contextCompaction'],
    )
    const after = (await device.call(IDLE_COMPACT_READ, { threadId })).result
    assert.equal(after.idle, true)
    assert.equal(after.lastTurnId, turnId, '压缩回合不算普通回合')
    assert.equal(after.lastTurnActivityAt, snapshot.lastTurnActivityAt)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('会话在跑或有排队输入时探测为不空闲', async () => {
  const { h, device, threadId } = await setup()
  try {
    let release = () => {}
    h.steps.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: '放行' })
        }),
    )
    const turnId = (
      await device.ok('turn/start', { threadId, input: [{ type: 'text', text: '慢慢说' }] })
    ).turn.id
    assert.equal((await device.call(IDLE_COMPACT_READ, { threadId })).result.idle, false)
    await device.until('模型收到请求', () => h.requests.length > 0)
    release()
    await device.completed(turnId)
    assert.equal((await device.call(IDLE_COMPACT_READ, { threadId })).result.idle, true)
  } finally {
    await h.dispose()
  }
})
