import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ManagerIssueHead } from '../../protocol/src/manager-issues.mjs'
import { createManagerIssueStub } from '../src/manager-issues-stub.mjs'
import type { ManagerBoardView } from '../src/model-manager.mjs'
import {
  DEFAULT_MANAGER_ISSUE_FILTER,
  filterManagerIssues,
  managerIssueFilterKey,
  managerIssuePending,
  managerIssueStatusOptions,
  managerIssueSummary,
  withManagerIssueKinds,
} from '../src/projection/manager-issue-list.mjs'

const head = (
  over: Partial<ManagerIssueHead> & Pick<ManagerIssueHead, 'id'>,
): ManagerIssueHead => ({
  aliases: [],
  kind: 'ordinary',
  title: over.id,
  preview: '',
  status: 'open',
  stateGroup: 'open',
  author: 'user',
  followUp: 'on',
  unread: false,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})
const heads = [
  head({
    id: 'D-1' as ManagerIssueHead['id'],
    kind: 'decision',
    status: 'open',
    createdAt: 10,
    author: 'manager',
  }),
  head({ id: 'X-2' as ManagerIssueHead['id'], createdAt: 20, updatedAt: 90 }),
  head({
    id: 'X-3' as ManagerIssueHead['id'],
    status: 'closed',
    followUp: 'off',
    createdAt: 30,
    author: 'manager',
  }),
  head({
    id: 'P-4' as ManagerIssueHead['id'],
    kind: 'report',
    status: 'unread',
    unread: true,
    createdAt: 40,
  }),
  head({ id: 'X-5' as ManagerIssueHead['id'], followUp: 'off', unread: true, createdAt: 50 }),
]
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).join(',')

test('默认只看普通 issue，最新在前', () => {
  assert.equal(ids(filterManagerIssues(heads, DEFAULT_MANAGER_ISSUE_FILTER)), 'X-5,X-3,X-2')
})

test('类型、状态、创建者、跟进与未读组合过滤', () => {
  const all = { ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: [] }
  assert.equal(ids(filterManagerIssues(heads, { ...all, authors: ['manager'] })), 'X-3,D-1')
  assert.equal(ids(filterManagerIssues(heads, { ...all, followUp: 'off' })), 'X-5,X-3')
  assert.equal(ids(filterManagerIssues(heads, { ...all, unread: true })), 'X-5,P-4')
  assert.equal(ids(filterManagerIssues(heads, { ...all, statuses: ['open'] })), 'X-5,X-2,D-1')
  assert.equal(ids(filterManagerIssues(heads, { ...all, order: 'updated' })), 'X-2,X-5,P-4,X-3,D-1')
  assert.equal(ids(filterManagerIssues(heads, { ...all, order: 'oldest' })), 'D-1,X-2,X-3,P-4,X-5')
  // 待处理优先：未答决策、普通 issue 的未读；未读报告不算
  assert.equal(ids(filterManagerIssues(heads, { ...all, order: 'pending' })), 'X-5,D-1,P-4,X-3,X-2')
})

test('换类型丢掉不适用的状态；键与条件次序无关', () => {
  const filter = { ...DEFAULT_MANAGER_ISSUE_FILTER, statuses: ['open', 'blocked'] as const }
  const next = withManagerIssueKinds({ ...filter, statuses: [...filter.statuses] }, ['report'])
  assert.deepEqual(next.statuses, [])
  assert.deepEqual(managerIssueStatusOptions(['report']), ['unread', 'read'])
  assert.equal(
    managerIssueFilterKey({ ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['report', 'decision'] }),
    managerIssueFilterKey({ ...DEFAULT_MANAGER_ISSUE_FILTER, kinds: ['decision', 'report'] }),
  )
})

test('摘要：普通 issue 开放、等我看、暂停；报告未读不算待处理', () => {
  const summary = managerIssueSummary(heads)
  assert.deepEqual(summary.ordinary, { active: 2, unread: 1, paused: 1, total: 3 })
  assert.equal(summary.attention.decision, 1)
  assert.equal(summary.attention.report, 1)
  assert.equal(managerIssuePending(heads[3] as ManagerIssueHead), false)
})

const board = (): ManagerBoardView =>
  ({
    deviceId: 'd',
    managerId: 'm',
    decisions: [
      {
        id: 'D-2',
        title: 'B',
        background: '',
        options: [],
        status: 'open',
        revision: 1,
        createdAt: 100,
        updatedAt: 100,
      },
    ],
    requests: [],
    posts: [
      {
        id: 'P-1',
        kind: 'report',
        title: 'R',
        body: '',
        revision: 1,
        createdAt: 100,
        updatedAt: 100,
        unread: true,
      },
    ],
    items: [],
    lines: [],
    activities: [],
    changes: [],
  }) as unknown as ManagerBoardView

test('桩：特殊 issue 保留原编号，普通 issue 用 X-n，评论与跟进按版本校验', async () => {
  const stub = createManagerIssueStub({ now: () => 1000, lang: 'en' })
  stub.configure({ enabled: true, scene: 'empty' })
  stub.syncBoard('d', 'm', board())
  assert.deepEqual(Object.keys(stub.view('d', 'm').details).sort(), ['D-2', 'P-1'])
  assert.equal((await stub.read('d', 'm', 'P-1')).issue.kind, 'report')
  const { issue } = await stub.create('d', 'm', { title: 'New', body: '' })
  assert.equal(issue.id, 'X-1')
  await assert.rejects(stub.comment('d', 'm', { id: 'X-1', revision: 9, body: 'x' }), /changed/)
  const commented = await stub.comment('d', 'm', { id: 'X-1', revision: 1, body: 'x' })
  assert.equal(commented.issue.discussion.comments.length, 1)
  const paused = await stub.follow('d', 'm', { id: 'X-1', revision: 1, state: 'off' })
  assert.equal(paused.issue.followUp.state, 'off')
  await stub.list('d', 'm', DEFAULT_MANAGER_ISSUE_FILTER)
  const page = stub.view('d', 'm').pages[managerIssueFilterKey(DEFAULT_MANAGER_ISSUE_FILTER)]
  assert.equal(page?.total, 1)
  // 看板刷新不冲掉外壳自己的评论
  stub.syncBoard('d', 'm', board())
  const key = 'X-1' as keyof ReturnType<typeof stub.view>['details']
  assert.equal(stub.view('d', 'm').details[key]?.discussion.comments.length, 1)
  stub.configure({ scene: 'old' })
  assert.equal(stub.view('d', 'm').supported, false)
  await assert.rejects(stub.read('d', 'm', 'D-2'), /does not support/)
})
