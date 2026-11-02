import assert from 'node:assert/strict'
import test from 'node:test'
import { managerResetState } from '../src/screens/managers/reset.ts'

const manager = { harness: 'claude-code', status: 'active' }
const state = (phase, patch = {}) => ({
  ...manager,
  reset: { phase, mode: 'refresh', current: 'new', applied: 'old', outdated: true, ...patch },
})

test('手机重置：按设备给的方式展示有损确认，旧设备依 harness 判断', () => {
  assert.equal(managerResetState(manager, true).replace, false)
  assert.equal(managerResetState({ ...manager, harness: 'codex' }, true).replace, true)
  assert.equal(managerResetState(state('idle', { mode: 'replace' }), true).replace, true)
  assert.equal(managerResetState({ ...state('idle'), harness: 'claude' }, true).replace, false)
})

test('更新或失败有醒目提示，完成后清除；结束的经理不提示重置', () => {
  assert.equal(managerResetState(state('idle'), true).attention, true)
  assert.equal(managerResetState(state('ready', { outdated: false }), true).attention, false)
  assert.equal(managerResetState(state('failed', { outdated: false }), true).attention, true)
  assert.equal(managerResetState({ ...state('idle'), status: 'ended' }, true).attention, false)
})

test('等待、摘要、应用和正在提交时不重复发起；经理运行本身仍允许排队重置', () => {
  for (const phase of ['waiting', 'summarizing', 'applying'])
    assert.equal(managerResetState(state(phase), true).disabled, 'manager.resetWaiting')
  assert.equal(managerResetState(manager, true, true).disabled, 'manager.resetWaiting')
  assert.equal(managerResetState(manager, true).disabled, null)
  assert.equal(managerResetState(manager, false).disabled, 'manager.offline')
  assert.equal(
    managerResetState({ ...manager, status: 'ending' }, true).disabled,
    'manager.readOnly',
  )
})

test('只有摘要失败的再次确认才允许仅凭看板接手', () => {
  assert.equal(managerResetState(state('summaryFailed'), true).boardOnly, true)
  assert.equal(managerResetState(state('summaryFailed'), true).disabled, null)
  for (const phase of ['idle', 'waiting', 'summarizing', 'applying', 'failed', 'ready'])
    assert.equal(managerResetState(state(phase), true).boardOnly, false)
})
