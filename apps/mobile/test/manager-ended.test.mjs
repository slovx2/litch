import assert from 'node:assert/strict'
import test from 'node:test'
import { connectChannel, createCore, createPortPair, serveChannel } from '@litch/core'
import { sampleManagers } from '../../../packages/core/src/mock/sample-manager.mjs'
import { fakeDevice, harness } from '../../../packages/core/test/fake-device.mjs'
import { fakeOpener } from '../../../packages/core/test/fake-server.mjs'
import { thread } from '../../../packages/core/test/fixtures.mjs'
import { MANAGER_METHOD, MANAGER_NOTIFICATION } from '../../../packages/protocol/src/manager.mjs'
import { SessionStore } from '../src/core/session-store.ts'
import { until } from './helpers.mjs'

test('D09：手机工作台和详情共用的 SessionStore 随经理结束禁输入并显示原因', async () => {
  const manager = { ...sampleManagers('local', 1_800_000_000, 'zh-CN').managers[0], threadId: 'm1' }
  const fake = fakeDevice([harness('claude', { threads: [thread({ id: 'm1' })] })])
  fake.device.extensions = ['harness', 'litchManager']
  const peer = fakeOpener({
    ...fake.handlers,
    [MANAGER_METHOD.list]: () => ({ managers: [manager] }),
  })
  const timers = new Set()
  const clock = {
    now: () => Date.now(),
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms)
      timer.unref()
      timers.add(timer)
      return () => clearTimeout(timer)
    },
  }
  const core = createCore({
    clock,
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
  const [phone, service] = createPortPair()
  const close = serveChannel(service, core, { clock })
  const channel = connectChannel(phone)
  core.start()
  const store = new SessionStore(channel, 'local', 'm1')
  store.start()
  try {
    await until(() => store.getMeta()?.live, { what: '经理可输入' })
    for (const status of ['ending', 'ended']) {
      peer.last().notify(MANAGER_NOTIFICATION.changed, {
        manager: { ...manager, status, updatedAt: manager.updatedAt + 1 },
      })
      const key = status === 'ending' ? 'manager.endingNote' : 'manager.readOnly'
      await until(() => !store.getMeta()?.live && store.getMeta()?.note?.key === key, {
        what: '手机收到只读原因',
      })
      await assert.rejects(
        channel.command('session.send', {
          deviceId: 'local',
          sessionId: 'm1',
          text: '不能继续',
        }),
        { code: 'rejected' },
      )
    }
  } finally {
    store.stop()
    channel.close()
    close()
    core.stop()
    for (const timer of timers) clearTimeout(timer)
  }
})
