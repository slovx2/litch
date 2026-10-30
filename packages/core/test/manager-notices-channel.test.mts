import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MANAGER_METHOD, MANAGER_NOTIFICATION } from '../../protocol/src/manager.mjs'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  keys,
  type ManagerView,
  serveChannel,
} from '../src/index.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('设备看板失效经真实核心、通道与副本投递通知，不污染经理目录；重连不补发', async () => {
  const data = sampleManagers('local', 1_800_000_000, 'zh-CN')
  const manager = data.managers[0]
  const board = data.boards[0]
  assert.ok(manager && board)
  manager.contact.desktopNotification = true
  const fake = fakeDevice([harness('claude')])
  fake.device.extensions = ['harness', 'litchManager']
  const peer = fakeOpener({
    ...fake.handlers,
    [MANAGER_METHOD.list]: () => ({ managers: [manager] }),
    [MANAGER_METHOD.boardRead]: () => ({ board }),
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
  const stopServer = serveChannel(corePort, core, { clock: time.clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  const notices: string[] = []
  const stopListener = replica.onManagerDecision((owner, decision) => {
    assert.equal(owner.deviceId, 'local')
    notices.push(decision.id)
  })
  core.start()
  const stop = replica.start()
  const flush = async () => {
    await settle()
    await settle()
    time.advance(20)
    await settle()
  }
  try {
    await flush()
    assert.deepEqual(notices, [])
    const template = board.decisions[0]
    assert.ok(template)
    board.decisions.push({ ...template, id: 'D-99', status: 'open' })
    peer.last().notify(MANAGER_NOTIFICATION.boardChanged, { managerId: manager.id })
    await flush()
    assert.deepEqual(notices, ['D-99'])
    assert.equal(
      replica.store.get<ManagerView>(keys.manager('local', manager.id))?.name,
      manager.name,
    )
    peer.last().drop()
    await settle()
    board.decisions.push({ ...template, id: 'D-100', status: 'open' })
    time.advance(30_000)
    await flush()
    assert.ok(peer.servers.length > 1)
    assert.deepEqual(notices, ['D-99'])
    board.decisions.push({ ...template, id: 'D-101', status: 'open' })
    peer.last().notify(MANAGER_NOTIFICATION.boardChanged, { managerId: manager.id })
    await flush()
    assert.deepEqual(notices, ['D-99', 'D-101'])
  } finally {
    stopListener()
    stop()
    channel.close()
    stopServer()
    core.stop()
  }
})
