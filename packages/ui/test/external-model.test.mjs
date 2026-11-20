// 无人值守界面的纯逻辑（src/external/model.ts）：收件箱页签的查询、access 只读、来源状态与摘要、
// 候选聚合、新仓库默认草稿、经理分配冲突与缺写权限。桌面和手机共用这一份。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const m = await import('../src/external/model.ts')

test('收件箱页签：待分拣可按原因筛，已处理含已提醒，可只看已提醒', () => {
  assert.deepEqual(m.inboxFilter('pending', 'm1'), { managerId: 'm1', status: 'pending_triage' })
  assert.deepEqual(m.inboxFilter('pending', 'm1', { reason: 'rate_limited' }), {
    managerId: 'm1',
    status: 'pending_triage',
    reason: 'rate_limited',
  })
  assert.deepEqual(m.inboxFilter('processed', 'm1'), {
    managerId: 'm1',
    statuses: ['processed', 'notified'],
  })
  assert.deepEqual(m.inboxFilter('processed', 'm1', { onlyNotified: true }), {
    managerId: 'm1',
    status: 'notified',
  })
  assert.deepEqual(m.inboxFilter('blocked', 'm1', { reason: 'x' }), {
    managerId: 'm1',
    status: 'blocked',
  })
})

test('access 只有 true 才可用，缺省与非布尔都只读', () => {
  assert.equal(m.allowed(undefined, 'pauseSource'), false)
  assert.equal(m.allowed({}, 'pauseSource'), false)
  assert.equal(m.allowed({ pauseSource: 'yes' }, 'pauseSource'), false)
  assert.equal(m.allowed({ pauseSource: true }, 'pauseSource'), true)
})

const status = (enabled, state, pending = 0) => ({
  source: { enabled },
  coverage: [],
  ...(state ? { runtime: { state, backlog: { pending, limited: 0 } } } : {}),
})

test('来源状态：停用即暂停，否则取运行态；摘要按状态计数并合计待分拣', () => {
  assert.equal(m.sourceState(status(false, 'collecting')), 'paused')
  assert.equal(m.sourceState(status(true)), 'collecting')
  assert.equal(m.sourceState(status(true, 'backoff')), 'backoff')
  const sum = m.sourcesSummary([
    status(true, 'collecting', 2),
    status(false),
    status(true, 'blocked', 1),
  ])
  assert.deepEqual(sum.counts, { collecting: 1, paused: 1, backoff: 0, blocked: 1 })
  assert.equal(sum.pending, 3)
  assert.equal(sum.total, 3)
})

test('就绪四项按固定顺序，设备没报的项是未验证', () => {
  assert.deepEqual(
    m.readinessStates({ collect: { state: 'ok', diagnostics: [] } }).map((one) => one.state),
    ['ok', 'unverified', 'unverified', 'unverified'],
  )
})

test('主题标签从规范链接读出 owner/name#n，读不出只给编号', () => {
  assert.equal(m.subjectLabel({ url: 'https://github.com/a/b/issues/7', number: '7' }), 'a/b#7')
  assert.equal(m.subjectLabel({ url: 'https://example.com/x', number: '7' }), '#7')
})

test('原因码：认得的返回码本身，其余为 null', () => {
  assert.equal(m.knownReason('rate_limited'), 'rate_limited')
  assert.equal(m.knownReason('whatever'), null)
  assert.equal(m.knownReason(undefined), null)
})

test('同一候选的多条事件聚合成一行，保留先到的作代表', () => {
  const rows = m.groupInbox([
    { seq: 3, intakeId: 'a' },
    { seq: 2, intakeId: 'a' },
    { seq: 1 },
    { seq: 0, intakeId: 'b' },
  ])
  assert.deepEqual(
    rows.map((row) => [row.head.seq, row.count]),
    [
      [3, 2],
      [1, 1],
      [0, 1],
    ],
  )
})

const repository = {
  repoId: '20394867',
  owner: 'o',
  name: 'r',
  url: 'https://github.com/o/r',
  defaultBranch: 'main',
  defaultLabelId: '9301',
  grants: [
    { identityId: 'a', botUserId: '1', credentialRef: 'ca', read: true, write: 'verified' },
    { identityId: 'b', botUserId: '2', credentialRef: 'cb', read: true, write: 'missing' },
  ],
}

test('新仓库草稿：触发全开含默认标签，triage 门槛，即时反馈开，自动提醒关，按指定身份取凭据', () => {
  const draft = m.newSourceDraft(repository, {
    sourceId: m.sourceIdOf('20394867'),
    localRoot: '/w',
    pollIdentity: 'b',
  })
  assert.equal(draft.sourceId, 'github-20394867')
  assert.deepEqual(draft.triggers, {
    mention: true,
    assignment: true,
    reviewRequest: true,
    label: true,
    labelIds: ['9301'],
  })
  assert.equal(draft.minRole, 'triage')
  assert.equal(draft.credentialRef, 'cb')
  assert.equal(draft.unattended.autoNotify, false)
  assert.equal(draft.repos[0].immediateFeedback, true)
  assert.deepEqual(draft.repos[0].allowedBase, ['main'])
  // 设备自选时取第一个可读身份
  assert.equal(m.newSourceDraft(repository, { sourceId: 's', localRoot: '/w' }).credentialRef, 'ca')
})

test('经理分配：缺写权限只提示该身份的仓库；同仓库同身份分给别的经理是冲突', () => {
  assert.deepEqual(
    m.writeMissing({ identityId: 'b', repoIds: ['20394867'] }, [repository]).map((r) => r.repoId),
    ['20394867'],
  )
  assert.deepEqual(m.writeMissing({ identityId: 'a', repoIds: ['20394867'] }, [repository]), [])
  assert.deepEqual(m.writeMissing({ identityId: null, repoIds: [] }, [repository]), [])
  const all = [{ managerId: 'm2', identityId: 'a', repoIds: ['1', '2'], revision: 1 }]
  assert.deepEqual(
    m.assignmentConflicts({ managerId: 'm1', identityId: 'a', repoIds: ['2', '3'] }, all),
    ['2'],
  )
  assert.deepEqual(
    m.assignmentConflicts({ managerId: 'm2', identityId: 'a', repoIds: ['2'] }, all),
    [],
  )
  assert.deepEqual(
    m.assignmentConflicts({ managerId: 'm1', identityId: 'b', repoIds: ['2'] }, all),
    [],
  )
})

test('设备码倒计时：UTC 秒对客户端毫秒，不为负；显示为 分:秒', () => {
  assert.equal(m.secondsLeft(1000, 940_500), 59)
  assert.equal(m.secondsLeft(1000, 2_000_000), 0)
  assert.equal(m.clockText(581), '9:41')
  assert.equal(m.clockText(5), '0:05')
})
