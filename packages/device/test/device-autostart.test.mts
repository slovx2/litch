import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEVICE_AUTOSTART_METHOD } from '../../protocol/src/device-autostart.mjs'
import type { ControlChannel } from '../src/control.mjs'
import { DeviceAutostart } from '../src/device-autostart.mjs'

const admin = { declared: true, canRead: true, canConfigure: true }
const approved = { operationId: 'operation', expectedRevision: 0, confirmStop: true }

function fixture() {
  const calls: { method: string; params: unknown }[] = []
  const control: ControlChannel = {
    state: null,
    onState: null,
    onAsk: null,
    onInstall: null,
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'autostart.enable' || method === 'autostart.disable')
        return { state: 'accepted', operationId: 'operation', reconnect: true }
      return {}
    },
    close() {},
  }
  return { autostart: new DeviceAutostart(control, () => {}), calls }
}

for (const method of [DEVICE_AUTOSTART_METHOD.enable, DEVICE_AUTOSTART_METHOD.disable])
  test(`${method}：自启请求和重连许可分别发生在应答前后`, async () => {
    const { autostart, calls } = fixture()
    const reply = await autostart.call(method, approved, admin)
    assert.deepEqual(reply.result, { state: 'accepted', operationId: 'operation', reconnect: true })
    const controlMethod =
      method === DEVICE_AUTOSTART_METHOD.enable ? 'autostart.enable' : 'autostart.disable'
    assert.deepEqual(calls, [{ method: controlMethod, params: approved }])

    assert.ok(reply.afterReply)
    reply.afterReply()
    assert.deepEqual(calls.at(-1), {
      method: 'autostart.release',
      params: { operationId: 'operation' },
    })
  })

test('自启读取要求声明及设备读权限，修改要求设备配置权限', async () => {
  const { autostart, calls } = fixture()
  await assert.rejects(
    autostart.call(DEVICE_AUTOSTART_METHOD.get, {}, { ...admin, declared: false }),
    /requires litchDeviceAutostart/,
  )
  await assert.rejects(
    autostart.call(DEVICE_AUTOSTART_METHOD.get, {}, { ...admin, canRead: false }),
    { data: { litch: 'deviceAdminRequired' } },
  )
  await assert.rejects(
    autostart.call(DEVICE_AUTOSTART_METHOD.enable, approved, { ...admin, canConfigure: false }),
    { data: { litch: 'deviceAdminRequired' } },
  )
  await assert.rejects(
    autostart.call(DEVICE_AUTOSTART_METHOD.disable, { ...approved, allowLinger: true }, admin),
    /Invalid autostart/,
  )
  assert.equal(calls.length, 0)
  await autostart.call(DEVICE_AUTOSTART_METHOD.get, {}, { ...admin, canConfigure: false })
  assert.equal(calls[0]?.method, 'autostart.get')
})
