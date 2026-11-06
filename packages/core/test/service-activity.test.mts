import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCore } from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }
for (const supported of [true, false]) {
  test(`只读忙闲${supported ? '保留后台摘要与定时任务' : '对旧设备返回未知且不发送新方法'}`, async () => {
    const fake = fakeDevice([harness('pi')])
    if (supported) fake.device.extensions.push('serviceActivity')
    let asks = 0
    fake.handlers['litch/device/service/activity'] = () => {
      asks++
      return { turns: [], processes: 0, tasks: 1, background: 1, backgroundNames: ['npm run dev'] }
    }
    const peer = fakeOpener(fake.handlers)
    const core = createCore({
      clock: fakeClock().clock,
      version: '1.0.0',
      devices: [
        {
          id: 'local',
          name: '本机',
          host: 'test',
          kind: 'local',
          target: null,
          wire: 'green',
          open: peer.open,
        },
      ],
    })
    core.start()
    try {
      for (let i = 0; i < 8; i++) await settle()
      const result = await core.command('device.serviceActivity', { deviceId: 'local' }, never)
      assert.equal(asks, supported ? 1 : 0)
      assert.deepEqual(result, {
        busy: supported
          ? [
              { reason: 'tasks', harnesses: [], count: 1 },
              { reason: 'backgroundTasks', harnesses: [], count: 1, details: ['npm run dev'] },
            ]
          : null,
      })
    } finally {
      core.stop()
    }
  })
}
