// 飞书界面的纯逻辑（src/feishu/model.ts）：显示状态、原因代码、App ID 与机器人名校验、经理候选、
// 能力缺项与补申请条件、向导结束语。桌面和手机共用这一份。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const m = await import('../src/feishu/model.ts')

const app = (patch = {}) => ({
  appId: 'cli_0000000000000001',
  revision: 1,
  name: '助手',
  managerId: null,
  enabled: true,
  credential: { generation: 1, updatedAt: 0 },
  connection: { state: 'connected', since: 0, reconnects: 0 },
  capability: null,
  createdAt: 0,
  ...patch,
})

test('显示状态：停用优先，失败与重连带原因', () => {
  assert.equal(m.shownState(app()), 'connected')
  assert.equal(m.shownState(app({ enabled: false })), 'stopped')
  assert.equal(
    m.shownState(app({ connection: { state: 'stopped', since: 0, reconnects: 0 } })),
    'stopped',
  )
  const failed = app({
    connection: {
      state: 'failed',
      since: 0,
      reconnects: 3,
      error: { code: 'credential_rejected', at: 0 },
    },
  })
  assert.equal(m.shownState(failed), 'failed')
  assert.equal(m.STATE_TONE[m.shownState(failed)], 'err')
  assert.equal(m.connectionReason(failed), 'credential_rejected')
  // 已停用的不再说失败原因
  assert.equal(m.connectionReason({ ...failed, enabled: false }), null)
  assert.equal(m.connectionReason(app()), null)
})

test('原因代码：只认设备给的 feishu_ 代码', () => {
  assert.equal(m.feishuReason({ message: 'feishu_revision_conflict' }), 'revision_conflict')
  assert.equal(m.feishuReason({ message: 'feishu_manager_taken' }), 'manager_taken')
  assert.equal(m.feishuReason({ message: 'feishu_something_new' }), null)
  assert.equal(m.feishuReason({ message: 'Credential operation failed' }), null)
  assert.equal(m.feishuReason(null), null)
})

test('App ID 与机器人名校验', () => {
  assert.equal(m.validAppId('cli_a1b2c3d4e5f60718'), true)
  assert.equal(m.validAppId('cli_A1B2C3D4E5F60718'), false)
  assert.equal(m.validAppId('cli_a1b2'), false)
  assert.equal(m.botNameProblem('  '), 'empty')
  assert.equal(m.botNameProblem('助'.repeat(30)), null)
  assert.equal(m.botNameProblem('助'.repeat(31)), 'long')
  // 按字符数算：30 个表情不算超长
  assert.equal(m.botNameProblem('😀'.repeat(30)), null)
})

test('经理候选：已分给别的应用的标出来，当前经理不在列表时补上', () => {
  const apps = [
    app({ appId: 'cli_a', name: '甲', managerId: 'm1' }),
    app({ appId: 'cli_b', name: '乙', managerId: 'gone' }),
  ]
  const managers = [
    { id: 'm1', name: '经理一' },
    { id: 'm2', name: '经理二' },
  ]
  assert.deepEqual(m.managerOptions(apps, managers, 'cli_b'), [
    { id: 'm1', name: '经理一', takenBy: '甲' },
    { id: 'm2', name: '经理二', takenBy: null },
    { id: 'gone', name: 'gone', takenBy: null },
  ])
  assert.deepEqual(
    m.managerOptions(apps, managers, 'cli_a').map((one) => one.takenBy),
    [null, null],
  )
})

test('能力缺项与补申请：缺项且没有待审核版本才可补申请', () => {
  const capability = {
    checkedAt: 0,
    state: 'missing',
    missingScopes: ['im:message'],
    missingEvents: [],
    missingCallbacks: ['card.action.trigger'],
  }
  assert.deepEqual(
    m.missingGroups(capability).map((group) => group.kind),
    ['scopes', 'callbacks'],
  )
  assert.equal(m.canUpgrade(capability), true)
  const pending = { ...capability, publish: { state: 'pending_review', at: 0 } }
  assert.equal(m.pendingReview(pending), true)
  assert.equal(m.canUpgrade(pending), false)
  assert.equal(m.canUpgrade({ ...capability, state: 'ok' }), false)
  assert.equal(m.canUpgrade(null), false)
})

test('向导结束语：error 带原因时按原因说', () => {
  const base = { registrationId: 'r', revision: 2, name: 'x', expiresAt: 0 }
  assert.equal(m.registrationEnd({ ...base, state: 'succeeded', appId: 'cli_a' }), 'succeeded')
  assert.equal(m.registrationEnd({ ...base, state: 'expired' }), 'expired')
  assert.equal(m.registrationEnd({ ...base, state: 'error' }), 'error')
  assert.equal(
    m.registrationEnd({ ...base, state: 'error', error: 'lark_tenant' }),
    'error.lark_tenant',
  )
  assert.equal(m.secondsLeft(100, 40_500), 59)
  assert.equal(m.secondsLeft(100, 200_000), 0)
})
