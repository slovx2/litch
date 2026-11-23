import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreChannel, TopicSink } from '../src/channel/client.mjs'
import { sampleApp } from '../src/mock/sample-data.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import type { ManagerView } from '../src/model-manager.mjs'
import { createReplica, keys } from '../src/replica/replica.mjs'

test('经理目录按进行中和已结束分别计设备：分布变化及移除设备实时更新，原有总数不变', () => {
  let app!: TopicSink<'app'>
  const lists = new Map<string, TopicSink<'managers'>>()
  const channel: CoreChannel = {
    async command() {
      throw new Error('本用例不发送命令')
    },
    subscribe(topic, sink) {
      if (topic.kind === 'app') app = sink as TopicSink<'app'>
      if (topic.kind === 'managers' && 'deviceId' in topic)
        lists.set(topic.deviceId, sink as TopicSink<'managers'>)
      return () => {}
    },
    close() {},
  }
  const replica = createReplica(channel)
  const stop = replica.start()
  const view = sampleApp('zh-CN', 0)
  app.snapshot(view)
  const base = sampleManagers('local', 0, 'zh-CN').managers[0]!
  const row = (id: string, deviceId: string, status: ManagerView['status']): ManagerView => ({
    ...base,
    id,
    deviceId,
    status,
  })
  const put = (deviceId: string, managers: ManagerView[]) =>
    lists.get(deviceId)!.snapshot({ deviceId, available: true, managers })
  const summary = () => replica.store.get(keys.managersSummary)
  const a = row('a', 'local', 'active')
  const b = row('b', 'local', 'active')
  const e = row('e', 'build', 'ended')
  put('local', [a, b])
  put('build', [e])
  assert.deepEqual(summary(), {
    active: 2,
    ended: 1,
    total: 3,
    currentDevices: 1,
    endedDevices: 1,
  })
  // 总数相同，只把经理从本机移到远端，也必须刷新设备标题。
  put('local', [a])
  put('build', [{ ...b, deviceId: 'build' }, e])
  assert.deepEqual(summary(), {
    active: 2,
    ended: 1,
    total: 3,
    currentDevices: 2,
    endedDevices: 1,
  })
  lists.get('local')!.delta([{ op: 'manager.upsert', manager: { ...a, status: 'ended' } }])
  assert.deepEqual(summary(), {
    active: 1,
    ended: 2,
    total: 3,
    currentDevices: 1,
    endedDevices: 2,
  })
  app.snapshot({ ...view, devices: view.devices.filter(({ id }) => id !== 'build') })
  assert.deepEqual(summary(), {
    active: 0,
    ended: 1,
    total: 1,
    currentDevices: 0,
    endedDevices: 1,
  })
  stop()
})
