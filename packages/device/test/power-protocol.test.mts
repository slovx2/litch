import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEVICE_POWER_CHANGED,
  DEVICE_POWER_READ,
  type DevicePowerStatus,
} from '../../protocol/src/device-power.mjs'
import { FakeControl } from './fake-control.mjs'
import { rig, settle } from './helpers.mjs'

test('电源读取和通知按投递连接声明隔离，客户端读取不改变本机归属', async () => {
  const control = new FakeControl([])
  const status: DevicePowerStatus = {
    supported: true,
    configuredForLocalService: true,
    state: 'inactive',
    reasons: [],
    powerSource: 'ac',
    working: 0,
    text: { 'zh-CN': '没有保活来源', en: 'No request' },
  }
  assert.ok(control.state)
  control.state.power = status
  control.handlers['power.read'] = () => control.state?.power
  control.handlers['power.activity'] = () => control.state?.power
  const instance = rig({}, {}, { control })
  try {
    const phone = instance.connect()
    const ordinary = instance.connect()
    await phone.initialize(['harness', 'deviceSettings', 'devicePower'])
    await ordinary.initialize(['harness', 'deviceSettings'])
    assert.deepEqual(await phone.call(DEVICE_POWER_READ, {}), status)
    await assert.rejects(
      phone.call('litch/internal/power/activity', { harness: 'pi' }),
      (error) => (error as { code?: number }).code === -32601,
    )
    await assert.rejects(
      ordinary.call(DEVICE_POWER_READ, {}),
      (error) => (error as { data?: { litch?: string } }).data?.litch === 'extensionRequired',
    )
    const next = { ...status, state: 'requested' as const, reasons: ['pluggedIn'] as const }
    assert.ok(control.state)
    control.state = { ...control.state, power: { ...next, reasons: [...next.reasons] } }
    control.onState?.(control.state)
    await phone.waitFor(
      (frame) =>
        frame.method === DEVICE_POWER_CHANGED &&
        (frame.params as DevicePowerStatus).state === 'requested',
    )
    await settle()
    assert.equal(
      ordinary.notifications.some((frame) => frame.method === DEVICE_POWER_CHANGED),
      false,
    )
  } finally {
    await instance.close()
  }
})
