import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ManagerIssue } from '../../protocol/src/manager-issues.mjs'
import { managerIssueQueryKey } from '../src/model-manager-issues.mjs'
import {
  DEFAULT_MANAGER_ISSUE_FILTER,
  MANAGER_ISSUE_SUMMARY_FILTERS,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssuePageKey,
  managerIssueQuery,
  managerIssueStatusOptions,
  withManagerIssueKinds,
} from '../src/projection/manager-issue-list.mjs'

test('默认条件只查普通 issue，最新在前，不带未读与游标', () => {
  assert.deepEqual(managerIssueQuery('m1', DEFAULT_MANAGER_ISSUE_FILTER), {
    managerId: 'm1',
    kinds: ['ordinary'],
    statuses: [],
    authors: [],
    followUp: 'all',
    order: 'newest',
  })
})

test('条件里的数组按固定次序给设备，页键与选择次序无关', () => {
  const a = managerIssueQuery('m1', {
    ...DEFAULT_MANAGER_ISSUE_FILTER,
    kinds: ['report', 'ordinary'],
    statuses: ['closed', 'open'],
    authors: ['manager', 'user'],
    unread: true,
  })
  assert.deepEqual(a.kinds, ['ordinary', 'report'])
  assert.deepEqual(a.statuses, ['open', 'closed'])
  assert.deepEqual(a.authors, ['user', 'manager'])
  assert.equal(a.unread, true)
  const b = managerIssuePageKey('m1', {
    ...DEFAULT_MANAGER_ISSUE_FILTER,
    kinds: ['ordinary', 'report'],
    statuses: ['open', 'closed'],
    authors: ['user', 'manager'],
    unread: true,
  })
  assert.equal(managerIssueQueryKey(a), b)
  // 类型为空表示全部类型
  assert.equal(
    managerIssueQuery('m1', { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: [] }).kinds?.length,
    5,
  )
})

test('换类型丢掉不适用的状态；过滤键与条件次序无关', () => {
  const filter = withManagerIssueKinds(
    { ...DEFAULT_MANAGER_ISSUE_FILTER, statuses: ['in_progress', 'open'] },
    ['decision'],
  )
  assert.deepEqual(filter.statuses, ['open'])
  assert.ok(managerIssueStatusOptions([]).includes('unread'))
  assert.equal(
    managerIssueFilterKey({ ...filter, kinds: ['decision', 'report'] }),
    managerIssueFilterKey({ ...filter, kinds: ['report', 'decision'] }),
  )
})

test('概览三个数各用一条只取一行的查询，暂停只算还开着的', () => {
  const paused = managerIssueQuery('m1', MANAGER_ISSUE_SUMMARY_FILTERS.paused, 1)
  assert.deepEqual(paused.statuses, ['open', 'in_progress', 'blocked'])
  assert.equal(paused.followUp, 'off')
  assert.equal(paused.limit, 1)
  assert.equal(managerIssueQuery('m1', MANAGER_ISSUE_SUMMARY_FILTERS.unread, 1).unread, true)
})

test('完整 issue 收成列表行：预览取第一段非空文字', () => {
  const issue = {
    id: 'X-3',
    kind: 'ordinary',
    title: '标题',
    body: '\n\n第一段\n  接着\n\n第二段',
    status: 'open',
    stateGroup: 'open',
    author: { kind: 'user' },
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    followUp: { state: 'off', changedAt: 1, changedBy: 'user' },
    discussion: { comments: [], questions: [], summary: null },
    relations: [],
    timeline: [],
    quick: {},
    unread: true,
  } satisfies ManagerIssue
  const head = managerIssueHead(issue)
  assert.equal(head.preview, '第一段 接着')
  assert.equal(head.author, 'user')
  assert.equal(head.followUp, 'off')
})

test('讨论页签与专属页签缓存分离；概览预设仍只选 X-n', () => {
  const base = { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['decision'] as const }
  const all = { ...base, kinds: [...base.kinds] }
  const discussion = { ...all, discussionsOnly: true }
  assert.notEqual(managerIssuePageKey('m1', all), managerIssuePageKey('m1', discussion))
  assert.equal(managerIssueQuery('m1', discussion).discussionsOnly, true)
  for (const filter of Object.values(MANAGER_ISSUE_SUMMARY_FILTERS)) {
    assert.deepEqual(filter.kinds, ['ordinary'])
    assert.equal(filter.discussionsOnly, true)
  }
})
