import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

// issue 筛选的状态分组（filter-groups.ts，桌面和手机共用）：映射表、分组展开、读回、换类型、清除、旧值回退。
const bundle = await build({
  entryPoints: [new URL('../src/manager/issues/filter-groups.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const g = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)
const listBundle = await build({
  entryPoints: [
    new URL('../../core/src/projection/manager-issue-list.mts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const list = await import(
  `data:text/javascript;base64,${Buffer.from(listBundle.outputFiles[0].text).toString('base64')}`
)
const base = (kind) => list.managerIssueKindFilter(kind)
const ALL_KINDS = ['ordinary', 'decision', 'suggestion', 'request', 'report']

test('每个具体状态恰好归一个基本分组，映射与设计一致', () => {
  const statuses = [...new Set(Object.values(list.MANAGER_ISSUE_STATUSES).flat())]
  assert.deepEqual(Object.keys(g.ISSUE_STATUS_GROUP).sort(), statuses.sort())
  assert.deepEqual(
    Object.fromEntries(
      ['todo', 'doing', 'done', 'dropped'].map((group) => [
        group,
        Object.entries(g.ISSUE_STATUS_GROUP)
          .filter(([, one]) => one === group)
          .map(([status]) => status)
          .sort(),
      ]),
    ),
    {
      todo: ['endorsed', 'open', 'unread'],
      doing: ['blocked', 'in_progress', 'pending'],
      done: ['answered', 'closed', 'delivered', 'read', 'replied', 'resolved', 'started'],
      dropped: ['cancelled', 'dismissed', 'expired', 'ignored', 'withdrawn'],
    },
  )
})

test('分组展开成所选类型的状态；各页签默认就是待处理分组', () => {
  for (const kind of ALL_KINDS)
    assert.deepEqual(g.issueGroupStatuses('todo', [kind]), base(kind).statuses, kind)
  assert.deepEqual(g.issueGroupStatuses('unfinished', ['ordinary']), [
    'open',
    'in_progress',
    'blocked',
  ])
  assert.deepEqual(g.issueGroupStatuses('done', ['decision', 'request']), [
    'answered',
    'delivered',
    'replied',
  ])
  assert.deepEqual(g.issueGroupStatuses('all', ['ordinary']), [])
  // kinds 为空表示全部类型
  assert.deepEqual(g.issueGroupStatuses('todo', []), ['open', 'endorsed', 'unread'])
})

test('选项不随类型数量膨胀：空组、与待处理相同的未完成都不出', () => {
  assert.deepEqual(g.issueStatusGroups(['ordinary']), [
    'todo',
    'doing',
    'unfinished',
    'done',
    'all',
  ])
  assert.deepEqual(g.issueStatusGroups(['decision']), ['todo', 'done', 'dropped', 'all'])
  assert.deepEqual(g.issueStatusGroups(['report']), ['todo', 'done', 'all'])
  for (let n = 1; n <= ALL_KINDS.length; n++)
    assert.ok(g.issueStatusGroups(ALL_KINDS.slice(0, n)).length <= 6)
  assert.deepEqual(g.issueStatusGroups([]), g.ISSUE_STATUS_GROUPS)
})

test('读回：整组、细分、全部；读不出返回 null', () => {
  assert.deepEqual(g.readIssueStatus([], ['ordinary']), { group: 'all', detail: null })
  assert.deepEqual(g.readIssueStatus(['blocked', 'in_progress'], ['ordinary']), {
    group: 'doing',
    detail: null,
  })
  // 概览“还开着的”预设
  assert.deepEqual(g.readIssueStatus(['open', 'in_progress', 'blocked'], ['ordinary']), {
    group: 'unfinished',
    detail: null,
  })
  // 决策没有进行中：未完成与待处理一样，读成待处理
  assert.deepEqual(g.readIssueStatus(['open'], ['decision']), { group: 'todo', detail: null })
  assert.deepEqual(g.readIssueStatus(['expired'], ['decision']), {
    group: 'dropped',
    detail: 'expired',
  })
  assert.equal(g.readIssueStatus(['open', 'answered'], ['decision']), null)
  assert.equal(g.readIssueStatus(['read'], ['decision']), null)
  assert.equal(g.readIssueStatus(['blocked'], ['ordinary', 'decision']), null)
})

test('细分只在单一类型、组内多于一个状态时出现；未完成和全部没有细分', () => {
  assert.deepEqual(g.issueStatusDetails('doing', ['ordinary']), ['in_progress', 'blocked'])
  assert.deepEqual(g.issueStatusDetails('todo', ['ordinary']), [])
  assert.deepEqual(g.issueStatusDetails('unfinished', ['ordinary']), [])
  assert.deepEqual(g.issueStatusDetails('all', ['ordinary']), [])
  assert.deepEqual(g.issueStatusDetails('doing', ['ordinary', 'suggestion']), [])
  const filter = g.withIssueStatusDetail(base('ordinary'), 'doing', 'blocked')
  assert.deepEqual(filter.statuses, ['blocked'])
  assert.deepEqual(g.withIssueStatusDetail(filter, 'doing', null).statuses, [
    'in_progress',
    'blocked',
  ])
})

test('多选类型：勾选保持分组重新展开、至少留一种、全勾等于全部', () => {
  let filter = g.withIssueStatusGroup(base('ordinary'), 'done')
  filter = g.toggleIssueKind(filter, 'decision')
  assert.deepEqual(filter.kinds, ['ordinary', 'decision'])
  assert.deepEqual(filter.statuses, ['resolved', 'closed', 'answered'])
  filter = g.toggleIssueKind(filter, 'ordinary')
  filter = g.toggleIssueKind(filter, 'decision')
  assert.deepEqual(filter.kinds, ['decision'], '最后一种不能去掉')
  for (const kind of ['ordinary', 'suggestion', 'request', 'report'])
    filter = g.toggleIssueKind(filter, kind)
  assert.deepEqual(filter.kinds, [])
  assert.ok(ALL_KINDS.every((kind) => g.issueKindChecked(filter, kind)))
  // 新类型没有这一组时回到待处理
  const doing = g.withIssueStatusGroup(base('ordinary'), 'doing')
  assert.deepEqual(g.withIssueKinds(doing, ['decision']).statuses, ['open'])
  // 细分在多选时收回整组
  const blocked = g.withIssueStatusDetail(base('ordinary'), 'doing', 'blocked')
  assert.deepEqual(g.withIssueKinds(blocked, ['ordinary', 'suggestion']).statuses, [
    'in_progress',
    'blocked',
    'pending',
  ])
})

test('生效数与清除筛选：排序不算、清除保留排序', () => {
  assert.equal(g.issueActiveFilterCount(base('ordinary'), 'ordinary'), 0)
  const filter = {
    ...g.toggleIssueKind(base('ordinary'), 'report'),
    authors: ['manager'],
    unread: true,
    followUp: 'off',
    order: 'oldest',
  }
  assert.equal(g.issueActiveFilterCount(filter, 'ordinary'), 4)
  assert.equal(g.issueActiveFilterCount(g.withIssueStatusGroup(filter, 'all'), 'ordinary'), 5)
  const cleared = g.clearIssueFilter(filter, 'ordinary')
  assert.equal(cleared.order, 'oldest')
  assert.equal(g.issueActiveFilterCount(cleared, 'ordinary'), 0)
  assert.equal(
    list.managerIssueFilterKey(cleared),
    list.managerIssueFilterKey({ ...base('ordinary'), order: 'oldest' }),
  )
})

test('旧值回退：读得出原样返回，读不出回到待处理分组', () => {
  const ok = { ...base('decision'), statuses: ['expired'] }
  assert.equal(g.normalizeIssueFilter(ok), ok)
  const legacy = { ...base('decision'), statuses: ['open', 'answered', 'expired'] }
  assert.deepEqual(g.normalizeIssueFilter(legacy).statuses, ['open'])
  const mixed = { ...base('ordinary'), kinds: [], statuses: ['blocked', 'answered'] }
  assert.deepEqual(g.normalizeIssueFilter(mixed).statuses, ['open', 'endorsed', 'unread'])
})
