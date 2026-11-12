import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ManagerIssue } from '../../protocol/src/manager-issues.mjs'
import { sampleManagerIssues } from '../src/mock/sample-manager-issues.mjs'
import { managerIssueQueryKey } from '../src/model-manager-issues.mjs'
import {
  DEFAULT_MANAGER_ISSUE_FILTER,
  MANAGER_ISSUE_SUMMARY_FILTERS,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssueKindFilter,
  managerIssueLinkFilter,
  managerIssuePageKey,
  managerIssuePreset,
  managerIssueQuery,
  managerIssueStatusFilters,
  managerIssueStatusOptions,
  withManagerIssueKinds,
} from '../src/projection/manager-issue-list.mjs'

test('编号定位按真实类型与状态查询，清除隐藏目标的过滤并保留排序', () => {
  for (const kind of ['ordinary', 'decision', 'request', 'report', 'suggestion'] as const) {
    for (const status of managerIssueStatusOptions([kind])) {
      const previous = {
        ...managerIssueKindFilter(kind),
        authors: ['user'] as const,
        followUp: 'on' as const,
        unread: true,
        order: 'oldest' as const,
      }
      const filter = managerIssueLinkFilter({ kind, status }, { ...previous, authors: ['user'] })
      assert.deepEqual(filter.kinds, [kind])
      assert.deepEqual(filter.statuses, [status])
      assert.deepEqual(filter.authors, [])
      assert.equal(filter.followUp, 'all')
      assert.equal(filter.unread, false)
      assert.equal(filter.order, 'oldest')
      assert.equal(filter.discussionsOnly, kind === 'ordinary' ? true : undefined)
      assert.equal(previous.unread, true, '不能改写传入的页签过滤')
    }
  }
})

test('类别首次默认只看开放、待开始或未读，全部最后；通用全量查询底子不变', () => {
  for (const [kind, statuses] of Object.entries({
    ordinary: ['open'],
    decision: ['open'],
    suggestion: ['endorsed'],
    request: ['open'],
    report: ['unread'],
  }) as [ManagerIssue['kind'], ManagerIssue['status'][]][]) {
    const filter = managerIssueKindFilter(kind)
    assert.deepEqual(managerIssueQuery('m1', filter).statuses, statuses)
    assert.deepEqual(managerIssueStatusFilters(kind, [kind])[0]?.statuses, statuses)
    assert.equal(managerIssueStatusFilters(kind, [kind]).at(-1)?.key, 'all')
    filter.statuses.push('closed')
    assert.deepEqual(managerIssueKindFilter(kind).statuses, statuses, '类别之间不共享可变数组')
  }
  assert.deepEqual(DEFAULT_MANAGER_ISSUE_FILTER.statuses, [])
  assert.deepEqual(MANAGER_ISSUE_SUMMARY_FILTERS.unread.statuses, [])
})

test('概览预设保留显式 kinds 并切换页签，不影响 ordinary 默认范围', () => {
  for (const kind of ['decision', 'suggestion', 'request', 'report'] as const) {
    const patch = { kinds: [kind], unread: true }
    const next = managerIssuePreset(patch)
    assert.equal(next.kind, kind)
    assert.deepEqual(next.filter.kinds, [kind])
    assert.equal(next.filter.unread, true)
    assert.equal(next.filter.discussionsOnly, undefined)
    assert.deepEqual(patch, { kinds: [kind], unread: true })
  }
  assert.deepEqual(managerIssuePreset({}).filter.kinds, ['ordinary'])
  assert.deepEqual(managerIssueKindFilter('ordinary').kinds, ['ordinary'])
  const mixed = managerIssuePreset({ kinds: ['decision', 'report'] })
  assert.equal(mixed.kind, 'ordinary')
  assert.deepEqual(mixed.filter.kinds, ['decision', 'report'])
})

test('建议默认排除待审核，待开始在首位，待审核仍可单独选择', () => {
  const filter = managerIssueKindFilter('suggestion')
  const options = managerIssueStatusFilters('suggestion', ['suggestion'])
  assert.deepEqual(filter.statuses, ['endorsed'])
  assert.equal(filter.statuses.includes('pending'), false)
  assert.deepEqual(options[0], {
    key: 'endorsed',
    label: 'issue.status.endorsed',
    statuses: ['endorsed'],
  })
  assert.deepEqual(options[1]?.statuses, ['pending'])
  assert.equal(options.at(-1)?.key, 'all')
})

test('大量 issue 预览在新的默认开放过滤下仍能翻页，并保留已完成样本供全部对照', () => {
  const rows = sampleManagerIssues('m3', [], 1_800_000_000_000, 'zh-CN')
  const filter = managerIssueKindFilter('ordinary')
  const defaults = rows.filter((row) => filter.statuses.includes(row.status))
  assert.equal(rows.length, 120)
  assert.ok(defaults.length > 30 && defaults.length < rows.length)
  assert.ok(rows.some((row) => row.status === 'resolved'))
  assert.ok(rows.some((row) => row.status === 'closed'))
})

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
