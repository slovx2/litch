import assert from 'node:assert/strict'
import test from 'node:test'
import type { DevicePowerStatus } from '../../protocol/src/device-power.mjs'
import type { DeviceSettingsReadResponse } from '../../protocol/src/device-settings.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import { createManagement, type ManagementHost } from '../src/device/manage.mjs'
import {
  connectChannel,
  createPortPair,
  createReplica,
  type DevicePowerView,
  keys,
  type SettingsSnapshotView,
  serveChannel,
} from '../src/index.mjs'
import type { ManageView } from '../src/model-manage.mjs'
import { fakeClock } from './helpers.mjs'

const settings: DeviceSettingsReadResponse = {
  schema: { groups: [], settings: [] },
  snapshot: { version: 0, values: {}, explicit: [], pendingRestart: [], sshEntries: [] },
  inheritedEnv: [],
}
const power = (state: DevicePowerStatus['state']): DevicePowerStatus => ({
  supported: true,
  configuredForLocalService: true,
  state,
  reasons: state === 'requested' ? ['working'] : [],
  powerSource: 'ac',
  working: 0,
  text: { 'zh-CN': state, en: state },
})
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('读取电源状态途中到的新通知不能被旧应答覆盖，状态不改变设置版本', async () => {
  let finish!: (value: DevicePowerStatus) => void
  const pending = new Promise<DevicePowerStatus>((resolve) => {
    finish = resolve
  })
  const management = createManagement({
    deviceId: 'phone-ssh',
    online: () => true,
    supported: () => true,
    powerSupported: () => true,
    request: ((method: string) =>
      Promise.resolve(
        method === 'litch/device/power/read' ? pending : settings,
      )) as ManagementHost['request'],
    fail: () => new ChannelError('internal', '失败'),
    log() {},
  })
  const views: ManageView[] = []
  const changes: unknown[] = []
  management.open({
    snapshot: (value) => views.push(value as ManageView),
    delta: (ops) => changes.push(...ops),
    error: (error) => {
      throw error
    },
  })
  management.powerChanged({ ...power('requested'), powerSource: 'battery' })
  finish(power('inactive'))
  await settle()
  assert.deepEqual(views[0]?.power, {
    supported: true,
    state: 'requested',
    powerSource: 'battery',
    reasons: ['working'],
    text: { 'zh-CN': 'requested', en: 'requested' },
  } satisfies DevicePowerView)
  assert.equal(views[0]?.snapshot.version, 0)
  management.powerChanged(power('inactive'))
  assert.deepEqual(changes, [
    {
      op: 'power.set',
      value: {
        supported: true,
        state: 'inactive',
        powerSource: 'ac',
        reasons: [],
        text: { 'zh-CN': 'inactive', en: 'inactive' },
      },
    },
  ])
})

test('没有电源能力时不发新方法，未登记服务的状态不显示为本机保活', async () => {
  const calls: string[] = []
  const management = createManagement({
    deviceId: 'remote',
    online: () => true,
    supported: () => true,
    request: ((method: string) => {
      calls.push(method)
      return Promise.resolve(settings)
    }) as ManagementHost['request'],
    fail: () => new ChannelError('internal', '失败'),
    log() {},
  })
  const views: ManageView[] = []
  const changes: unknown[] = []
  management.open({
    snapshot: (value) => views.push(value as ManageView),
    delta: (ops) => changes.push(...ops),
    error: (error) => {
      throw error
    },
  })
  await settle()
  assert.deepEqual(calls, ['litch/device/settings/read'])
  assert.equal(views[0]?.power, null)
  management.powerChanged({ ...power('inactive'), configuredForLocalService: false })
  assert.deepEqual(changes, [{ op: 'power.set', value: null }])
})

test('初始读取途中取消本机归属，旧注册状态不能重新出现', async () => {
  let finish!: (value: DevicePowerStatus) => void
  const pending = new Promise<DevicePowerStatus>((resolve) => {
    finish = resolve
  })
  const management = createManagement({
    deviceId: 'local',
    online: () => true,
    supported: () => true,
    powerSupported: () => true,
    request: ((method: string) =>
      Promise.resolve(
        method === 'litch/device/power/read' ? pending : settings,
      )) as ManagementHost['request'],
    fail: () => new ChannelError('internal', '失败'),
    log() {},
  })
  const views: ManageView[] = []
  const close = management.open({
    snapshot: (value) => views.push(value as ManageView),
    delta() {},
    error(error) {
      throw error
    },
  })
  management.powerChanged({ ...power('inactive'), configuredForLocalService: false })
  finish(power('requested'))
  await settle()
  assert.equal(views[0]?.power, null)
  close()
})

test('工具栏常驻且面板首次读取失败时，面板重试换订阅但保留工具栏引用', async () => {
  let reads = 0
  const management = createManagement({
    deviceId: 'local',
    online: () => true,
    supported: () => true,
    powerSupported: () => true,
    request: ((method: string) => {
      if (method === 'litch/device/power/read') return Promise.resolve(power('requested'))
      reads++
      return reads === 1 ? Promise.reject(new Error('首读失败')) : Promise.resolve(settings)
    }) as ManagementHost['request'],
    fail: () => new ChannelError('internal', '首读失败'),
    log() {},
  })
  const time = fakeClock()
  const [ui, core] = createPortPair()
  const stopHost = serveChannel(
    core,
    {
      command: async () => null,
      subscribe(topic, sink) {
        assert.equal(topic.kind, 'manage')
        return management.open(sink)
      },
    },
    { clock: time.clock },
  )
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const toolbar = replica.openManage('local')
  let panel = replica.openManage('local')
  await settle()
  assert.equal(reads, 1)
  assert.ok(replica.store.get(keys.manageError('local')))
  // 与ManagePanel的attempt effect相同：只释放它自己的引用，再重新打开。
  panel()
  panel = replica.openManage('local')
  await settle()
  assert.equal(reads, 2)
  assert.equal(replica.store.get(keys.manageError('local')), undefined)
  assert.equal(replica.store.get<DevicePowerView>(keys.managePower('local'))?.state, 'requested')
  panel()
  assert.ok(replica.store.get(keys.manage('local')), '工具栏仍持有新订阅')
  toolbar()
  assert.equal(replica.store.get(keys.manage('local')), undefined)
  assert.equal(replica.store.get(keys.managePower('local')), undefined)
  channel.close()
  stopHost()
})

test('结构化电源快照和供电通知经过通道存入managePower，不改设置开关或版本', async () => {
  const initial: DevicePowerStatus = { ...power('requested'), reasons: ['pluggedIn'] }
  const configured: DeviceSettingsReadResponse = {
    ...settings,
    schema: {
      groups: [
        {
          id: 'power',
          title: { 'zh-CN': '电源', en: 'Power' },
          description: null,
          scope: { kind: 'device' },
        },
      ],
      settings: [
        {
          key: 'power.keepAwakeWhilePluggedIn',
          group: 'power',
          type: 'boolean',
          title: { 'zh-CN': '接电时保持唤醒', en: 'Stay awake while plugged in' },
          description: { 'zh-CN': '', en: '' },
          scope: { kind: 'device' },
          default: false,
          restart: 'none',
        },
      ],
    },
    snapshot: {
      ...settings.snapshot,
      version: 7,
      values: { 'power.keepAwakeWhilePluggedIn': true },
      explicit: ['power.keepAwakeWhilePluggedIn'],
    },
  }
  const management = createManagement({
    deviceId: 'local',
    online: () => true,
    supported: () => true,
    powerSupported: () => true,
    request: ((method: string) =>
      Promise.resolve(
        method === 'litch/device/power/read' ? initial : configured,
      )) as ManagementHost['request'],
    fail: () => new ChannelError('internal', '失败'),
    log() {},
  })
  const time = fakeClock()
  const [ui, core] = createPortPair()
  const stopHost = serveChannel(
    core,
    {
      command: async () => {
        throw new Error('不应发送设置命令')
      },
      subscribe(topic, sink) {
        assert.equal(topic.kind, 'manage')
        return management.open(sink)
      },
    },
    { clock: time.clock },
  )
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const close = replica.openManage('local')
  await settle()
  const expected: DevicePowerView = {
    supported: true,
    state: 'requested',
    powerSource: 'ac',
    reasons: ['pluggedIn'],
    text: initial.text,
  }
  assert.deepEqual(replica.store.get(keys.managePower('local')), expected)
  const saved = replica.store.get<SettingsSnapshotView>(keys.manageSnapshot('local'))
  // 文字没变但电池来源和申请状态变了，不能靠文案或设置开关推断实际状态。
  management.powerChanged({ ...initial, state: 'inactive', powerSource: 'battery', reasons: [] })
  time.advance(16)
  await settle()
  assert.deepEqual(replica.store.get(keys.managePower('local')), {
    ...expected,
    state: 'inactive',
    powerSource: 'battery',
    reasons: [],
  })
  assert.strictEqual(replica.store.get(keys.manageSnapshot('local')), saved)
  assert.equal(saved?.version, 7)
  assert.equal(saved?.values['power.keepAwakeWhilePluggedIn'], true)
  management.powerChanged({
    ...initial,
    supported: false,
    state: 'unsupported',
    powerSource: 'unknown',
    reasons: [],
  })
  time.advance(16)
  await settle()
  assert.deepEqual(replica.store.get(keys.managePower('local')), {
    ...expected,
    supported: false,
    state: 'unsupported',
    powerSource: 'unknown',
    reasons: [],
  })
  management.powerChanged({ ...initial, configuredForLocalService: false })
  time.advance(16)
  await settle()
  assert.equal(replica.store.get(keys.managePower('local')), null)
  close()
  channel.close()
  stopHost()
})
