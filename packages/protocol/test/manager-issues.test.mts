import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_ISSUE_METHOD,
  MANAGER_ISSUE_NOTIFICATION,
  type ManagerIssue,
  type ManagerIssueActivityNotification,
  type ManagerIssueChangedNotification,
  type ManagerIssueQuery,
  managerIssueFixture,
  managerIssueRefKind,
} from '../src/manager-issues.mjs'

test('迁移后的旧对象和新普通 issue 使用同一公共快照外壳', () => {
  const migrated = managerIssueFixture.migratedDecision
  const ordinary = managerIssueFixture.newOrdinary
  assert.equal(migrated.id, 'D-7')
  assert.equal(migrated.kind, 'decision')
  assert.equal(migrated.quick.decision?.answerable, true)
  assert.equal(ordinary.id, 'X-1')
  assert.equal(ordinary.kind, 'ordinary')
  assert.deepEqual(ordinary.status, 'open')
  assert.equal(ordinary.followUp.state, 'on')

  const roundTrip = JSON.parse(JSON.stringify({ migrated, ordinary })) as {
    migrated: ManagerIssue
    ordinary: ManagerIssue
  }
  assert.deepEqual(roundTrip.migrated, migrated)
  assert.deepEqual(roundTrip.ordinary, ordinary)
})

test('issue ref 接受 X-n 和现有特殊类型编号，拒绝 I-n 和纯数字', () => {
  assert.equal(managerIssueRefKind('X-1'), 'ordinary')
  assert.equal(managerIssueRefKind('X-20'), 'ordinary')
  assert.equal(managerIssueRefKind('D-7'), 'special')
  assert.equal(managerIssueRefKind('R-2'), 'special')
  assert.equal(managerIssueRefKind('P-1'), 'special')
  assert.equal(managerIssueRefKind('S-proposal-1'), 'special')
  assert.equal(managerIssueRefKind('#1'), 'invalid')
  assert.equal(managerIssueRefKind('X-0'), 'invalid')
  assert.equal(managerIssueRefKind('D-0'), 'invalid')
  assert.equal(managerIssueRefKind('I-1'), 'invalid')
  assert.equal(managerIssueRefKind('not-an-issue'), 'invalid')
})

test('列表查询默认普通 issue，过滤器可表达五类和跟进状态', () => {
  const query: ManagerIssueQuery = {
    managerId: 'manager-1',
    kinds: ['ordinary', 'decision', 'report'],
    statuses: ['open', 'unread'],
    authors: ['user'],
    followUp: 'off',
    unread: true,
    order: 'updated',
    cursor: 'cursor-1',
    limit: 30,
  }
  assert.deepEqual(query.kinds, ['ordinary', 'decision', 'report'])
  assert.equal(query.followUp, 'off')
  assert.equal(query.unread, true)
  const defaults: ManagerIssueQuery = { managerId: 'manager-1', order: 'newest' }
  assert.equal(defaults.kinds, undefined)
  assert.equal(defaults.order, 'newest')
})

test('方法和通知属于新增 litchManagerIssues 能力，不改旧帖子方法', () => {
  assert.equal(MANAGER_ISSUE_METHOD.list, 'litch/manager/issues/list')
  assert.equal(MANAGER_ISSUE_METHOD.comment, 'litch/manager/issue/comment')
  assert.equal(MANAGER_ISSUE_METHOD.seen, 'litch/manager/issue/seen')
  assert.equal(MANAGER_ISSUE_NOTIFICATION.changed, 'litch/manager/issue/changed')
  assert.equal(MANAGER_ISSUE_NOTIFICATION.activity, 'litch/manager/issue/activity')
  assert.equal('post_get' in MANAGER_ISSUE_METHOD, false)
})

test('暂停跟进的评论事件仍可广播，但活动通知带 followUp=off', () => {
  const changed: ManagerIssueChangedNotification = {
    managerId: 'manager-1',
    issueId: 'X-1',
    revision: 2,
    change: 'commented',
  }
  const activity: ManagerIssueActivityNotification = {
    managerId: 'manager-1',
    issueId: 'X-1',
    eventId: 'event-2',
    kind: 'issue-comment',
    actor: 'user',
    followUp: 'off',
    unread: true,
  }
  assert.equal(changed.issueId, 'X-1')
  assert.equal(activity.followUp, 'off')
  assert.equal(activity.unread, true)
})
