// 设置里的“任务卡”那棵树（src/screens/settings/TaskCardsSection.tsx，判断和桌面共用 harness-switches-logic.ts）
// 接在模拟核心上：build-01 上的 Gemini CLI 在设置里停用着，不列、设备那一格和点了设整列都不算它；
// 启用之后列出来，它原来关着的任务卡照旧关着。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createReplica, keys, taskCardsSettingKey } from '@litch/core'
import {
  deviceCell,
  harnessRows,
  nextForDevice,
  taskCardTargets,
} from '../../../packages/ui/src/settings/harness-switches-logic.ts'
import { mockChannel, until } from './helpers.mjs'

const mock = mockChannel()
const replica = createReplica(mock.channel)
const stopReplica = replica.start()
const stopManage = replica.openManage('build')
after(() => {
  stopManage()
  stopReplica?.()
  mock.close()
})

const device = () => replica.store.get(keys.device('build'))
const snapshot = () => replica.store.get(keys.manageSnapshot('build'))
const ids = () => harnessRows(device()).map((row) => row.id)

/** 照界面点设备那一格：只写列出来的那些 */
async function flipDevice() {
  const before = deviceCell(device(), 'taskCards')
  const on = nextForDevice(before)
  await mock.channel.command('device.settings.write', {
    deviceId: 'build',
    expectedVersion: snapshot().version,
    edits: taskCardTargets(device()).map((id) => ({ key: taskCardsSettingKey(id), value: on })),
  })
  await until(() => deviceCell(device(), 'taskCards') === (on ? 'on' : 'off'), {
    what: `设备那一格变成${on ? '全开' : '全关'}`,
  })
}

test('停用的 harness 不列，点设备那一格设整列不动它；启用后出现，值照旧', async () => {
  await until(() => device() && snapshot(), { what: 'build-01 和它的设置' })
  assert.equal(device().harnesses.find((entry) => entry.id === 'gemini')?.state, 'disabled')
  assert.deepEqual(ids(), ['claude', 'pi', 'dsh', 'codex', 'opencode'])
  assert.ok(!taskCardTargets(device()).includes('gemini'))
  // 停用的那个任务卡关着，但不算进设备那一格
  assert.equal(device().tools.harnesses.gemini.taskCards, false)
  assert.equal(deviceCell(device(), 'taskCards'), 'on')

  // 关一次再开一次：列出来的跟着变，停用的那个一直是原来的值
  await flipDevice()
  await flipDevice()
  assert.equal(device().tools.harnesses.gemini.taskCards, false)

  await mock.channel.command('device.settings.write', {
    deviceId: 'build',
    expectedVersion: snapshot().version,
    edits: [{ key: 'harness.gemini.enabled', value: true }],
  })
  await until(() => ids().includes('gemini'), { what: '启用后 Gemini CLI 列出来' })
  assert.deepEqual(ids(), ['claude', 'pi', 'dsh', 'codex', 'opencode', 'gemini'])
  assert.equal(harnessRows(device()).at(-1).switches.taskCards, false)
  assert.equal(deviceCell(device(), 'taskCards'), 'mixed')
  assert.ok(taskCardTargets(device()).includes('gemini'))
})
