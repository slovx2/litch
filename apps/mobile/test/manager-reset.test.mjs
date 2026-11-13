import assert from 'node:assert/strict'
import test from 'node:test'
import {
  managerResetState,
  resetNextTarget,
  resetPreviewDetail,
  resetTargetParams,
} from '../src/screens/managers/reset.ts'

const manager = { harness: 'claude-code', status: 'active' }
const state = (phase, patch = {}) => ({
  ...manager,
  reset: { phase, mode: 'refresh', current: 'new', applied: 'old', outdated: true, ...patch },
})

const target = { harness: 'codex', model: 'gpt-6.1', effort: 'high', permission: ':workspace' }
const preview = {
  source: { ...target, harness: 'claude-code', model: 'claude-sonnet-4-6' },
  target,
  mode: 'replace',
  canSubmit: true,
  expectedThreadId: 'old',
  expectedSettingsHash: 'hash',
  capabilityChanges: [{ capability: 'nativeBackground', before: true, after: false }],
  dispatchChanges: [{ field: 'harness', before: 'claude-code', after: 'codex' }],
}

test('跨 harness 与型号变化清理原目录的值，当前权限始终固定', () => {
  assert.deepEqual(
    resetNextTarget(preview, { harness: 'claude-code', permission: ':danger-full-access' }),
    { ...target, harness: 'claude-code', model: null, effort: null },
  )
  assert.deepEqual(resetNextTarget(preview, { model: 'other' }), {
    ...target,
    model: 'other',
    effort: null,
  })
  assert.deepEqual(resetNextTarget(preview, { effort: 'low' }), { ...target, effort: 'low' })
})

test('提交携带计划身份；摘要失败用持久目标，忽略界面里的其他选择', () => {
  const value = { ...manager, deviceId: 'local', id: 'm1' }
  assert.deepEqual(resetTargetParams(value, preview, 'request'), {
    deviceId: 'local',
    managerId: 'm1',
    target,
    expectedThreadId: 'old',
    expectedSettingsHash: 'hash',
    requestId: 'request',
  })
  const operation = {
    source: { ...preview.source, threadId: 'original' },
    target,
    expectedSettingsHash: 'original-hash',
    requestId: 'original-request',
  }
  assert.deepEqual(
    resetTargetParams(
      { ...value, reset: { phase: 'summaryFailed', operation } },
      { ...preview, target: { ...target, harness: 'claude-code' } },
      'new-request',
    ),
    {
      deviceId: 'local',
      managerId: 'm1',
      boardOnly: true,
      target,
      expectedThreadId: 'original',
      expectedSettingsHash: 'original-hash',
      requestId: 'original-request',
    },
  )
})

test('跨引擎确认列出能力与派活变化，只使用换线程有损说明', () => {
  const t = Object.assign((key) => key, { harness: (id, name) => name ?? id })
  const detail = resetPreviewDetail(preview, t)
  assert.match(detail, /Claude Code.*→/)
  assert.match(detail, /Codex/)
  assert.match(detail, /manager.resetTargetReplace/)
  assert.match(detail, /manager.resetCapabilities/)
  assert.match(detail, /manager.resetDispatchChanges/)
  assert.match(detail, /manager.resetDispatchNote/)
  assert.doesNotMatch(detail, /manager.resetRefresh/)
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
    assert.equal(
      managerResetState(state(phase), true).disabled,
      phase === 'waiting' ? 'manager.resetWaiting' : 'manager.resetApplying',
    )
  assert.equal(managerResetState(manager, true, true).disabled, 'manager.resetApplying')
  assert.equal(managerResetState(manager, true).disabled, null)
  assert.equal(managerResetState(manager, false).disabled, 'manager.offline')
  assert.equal(
    managerResetState({ ...manager, status: 'ending' }, true).disabled,
    'manager.readOnly',
  )
})

test('手机标题栏只在 waiting 提供取消，离线和提交中禁用，区分刷新与换会话等待', () => {
  assert.equal(managerResetState(state('waiting'), true).cancellable, true)
  assert.equal(managerResetState(state('waiting'), true).cancelDisabled, false)
  assert.equal(managerResetState(state('waiting'), false).cancelDisabled, true)
  assert.equal(managerResetState(state('waiting'), true, true).cancelDisabled, true)
  assert.equal(
    managerResetState(state('waiting', { mode: 'replace' }), true).disabled,
    'manager.resetWaitingReplace',
  )
  for (const phase of ['idle', 'summarizing', 'applying', 'failed', 'ready'])
    assert.equal(managerResetState(state(phase), true).cancellable, false)
})

test('只有摘要失败的再次确认才允许仅凭看板接手', () => {
  assert.equal(managerResetState(state('summaryFailed'), true).boardOnly, true)
  assert.equal(managerResetState(state('summaryFailed'), true).disabled, null)
  for (const phase of ['idle', 'waiting', 'summarizing', 'applying', 'failed', 'ready'])
    assert.equal(managerResetState(state(phase), true).boardOnly, false)
})

test('已提交而接班失败单独标记，不能表现成成功', () => {
  const failed = state('ready', {
    outdated: false,
    operation: { committed: true, handover: 'failed' },
  })
  assert.equal(managerResetState(failed, true).handoverFailed, true)
  assert.equal(managerResetState(failed, true).attention, true)
  assert.equal(
    managerResetState(
      state('failed', { operation: { committed: false, handover: 'failed' } }),
      true,
    ).handoverFailed,
    false,
  )
})
