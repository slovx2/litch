import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_METHOD } from '../../protocol/src/manager.mjs'
import {
  MANAGER_ISSUE_METHOD as M,
  managerIssueFixture,
} from '../../protocol/src/manager-issues.mjs'
import { connectChannel, createCore, createPortPair, serveChannel } from '../src/index.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('真实核心通道：手动标记不发给设备；重试和整板刷新绕过冷却，自动查询不绕过', async () => {
  const sample = sampleManagers('local', 1_800_000_000, 'zh-CN')
  const manager = sample.managers[0]!
  const fake = fakeDevice([harness('claude')])
  fake.device.extensions = ['harness', 'litchManager', 'litchManagerIssues']
  let failed = true
  const calls: string[] = []
  const issueCall = (method: string, params: unknown) => {
    calls.push(method)
    assert.equal('manual' in (params as object), false, '手动标记只留在核心通道')
    if (failed) throw new Error('timeout')
    return method === M.list
      ? { page: { query: params, entries: [], total: 0, nextCursor: null } }
      : { issue: structuredClone(managerIssueFixture.newOrdinary) }
  }
  const peer = fakeOpener({
    ...fake.handlers,
    [MANAGER_METHOD.list]: () => ({ managers: [manager] }),
    [MANAGER_METHOD.boardRead]: () => ({ board: sample.boards[0] }),
    [M.list]: (p) => issueCall(M.list, p),
    [M.read]: (p) => issueCall(M.read, p),
  })
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '1.0.0',
    log() {},
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const [uiPort, corePort] = createPortPair()
  const stop = serveChannel(corePort, core, { clock: time.clock })
  const channel = connectChannel(uiPort)
  core.start()
  try {
    await settle()
    await settle()
    time.advance(20)
    await settle()
    const query = { deviceId: 'local', managerId: manager.id, order: 'newest' as const }
    await assert.rejects(channel.command('managers.issues.list', query), /timeout/)
    await assert.rejects(channel.command('managers.issues.list', query), /timeout/)
    assert.deepEqual(calls, [M.list])
    failed = false
    await channel.command('managers.issues.list', { ...query, manual: true })
    assert.deepEqual(calls, [M.list, M.list])
    failed = true
    const ref = { deviceId: 'local', managerId: manager.id, id: 'X-1' as const }
    await assert.rejects(channel.command('managers.issue.read', ref), /timeout/)
    failed = false
    await channel.command('managers.issue.read', { ...ref, manual: true })
    failed = true
    await assert.rejects(channel.command('managers.issues.list', query), /timeout/)
    const before = calls.length
    failed = false
    await channel.command('managers.board.refresh', { deviceId: 'local', managerId: manager.id })
    assert.deepEqual(calls.slice(before), [M.list, M.read], '整板按钮立即重读所有已订阅查询和详情')
  } finally {
    channel.close()
    stop()
    core.stop()
  }
})
