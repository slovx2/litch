import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createReplica, keys, pageSidebarProjection, projectSidebarGroups } from '@litch/core'
import { files } from 'expo-file-system'
import { recentRoute } from '../src/screens/devices/recent-route.ts'
import {
  descendantIds,
  recentTree,
  sessionHasActivity,
  sessionTree,
} from '../src/screens/sessions/tree.ts'
import { mockChannel, until } from './helpers.mjs'

afterEach(() => files.clear())

const children = { parent: ['child', 'sibling'], child: ['grandchild'], manager: ['line'] }
const activeDescendants = (root, children, active) =>
  descendantIds(root, children).filter((id) => active.includes(id)).length
const build = (root, folded = [], always = () => false, hidden = []) =>
  sessionTree(root, children, new Set(folded), hidden, always)

test('最近默认收起；每层独立展开，目录晚到和新子项遵循已记住的开合', () => {
  assert.deepEqual(
    recentTree('parent', children, []).map((row) => row.id),
    ['parent'],
  )
  assert.deepEqual(
    recentTree('parent', children, ['parent']).map((row) => row.id),
    ['parent', 'child', 'sibling'],
  )
  assert.deepEqual(
    recentTree('parent', children, ['parent', 'child']).map((row) => row.id),
    ['parent', 'child', 'grandchild', 'sibling'],
  )
  assert.deepEqual(
    recentTree('parent', {}, ['parent']).map((row) => row.id),
    ['parent'],
  )
  assert.equal(recentTree('parent', children, ['parent'])[0].folded, false)
})

test('最近按主项分组分页，普通子对话、经理工作线与孙会话跟随主项展开', () => {
  const summary = (id, parentId, manager) => ({
    id,
    workspaceId: 'w',
    updatedAt: 1,
    unread: false,
    ...(parentId ? { lineage: { parentId } } : {}),
    ...(manager ? { litchManager: { role: manager } } : {}),
  })
  const sessions = new Map([
    ['parent', summary('parent')],
    ['child', summary('child', 'parent')],
    ['sibling', summary('sibling', 'parent')],
    ['grandchild', summary('grandchild', 'child')],
    ['manager', summary('manager', undefined, 'manager')],
    ['line', summary('line', 'manager', 'line')],
  ])
  const rows = projectSidebarGroups('d', sessions, (id) =>
    id === 'line' ? 20 : id === 'grandchild' ? 10 : 0,
  ).recent
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['manager', 'parent'],
  )
  for (const grouped of [false, true]) {
    const page = pageSidebarProjection(rows, grouped, 1)
    assert.equal(page.remaining, 1)
    assert.deepEqual(
      page.blocks
        .flatMap((block) => block.rows.flatMap((row) => build(row.sessionId)))
        .map((row) => row.id),
      ['manager', 'line'],
    )
  }
  assert.deepEqual(
    build('parent').map(({ id, depth }) => [id, depth]),
    [
      ['parent', 0],
      ['child', 1],
      ['grandchild', 2],
      ['sibling', 1],
    ],
  )
})

test('收起隐藏普通子项，未读与待处理直接子项仍显示；展开恢复完整顺序', () => {
  assert.deepEqual(
    build('parent', ['parent']).map((row) => row.id),
    ['parent'],
  )
  const folded = build('parent', ['parent', 'child'], (id) => id === 'child' || id === 'sibling')
  assert.deepEqual(
    folded.map((row) => row.id),
    ['parent', 'child', 'sibling'],
  )
  assert.equal(folded[0].kids, 2)
  assert.equal(folded[0].folded, true)
  assert.deepEqual(
    build('parent', ['child']).map((row) => row.id),
    ['parent', 'child', 'sibling'],
  )
  assert.equal(build('parent').length, 4)
  assert.deepEqual(
    build('parent', [], () => false, ['child']).map((row) => row.id),
    ['parent', 'sibling'],
  )
})

test('折叠提示计入未读、等待、运行与后台活动的全部后代，不计父项和其他树', () => {
  assert.equal(sessionHasActivity(undefined), false)
  assert.equal(sessionHasActivity({ status: 'idle', unread: false }), false)
  for (const summary of [
    { status: 'running' },
    { status: 'waiting' },
    { unread: true },
    { background: { running: 1 } },
  ])
    assert.equal(sessionHasActivity(summary), true)
  assert.equal(activeDescendants('parent', children, ['parent', 'line']), 0)
  assert.equal(activeDescendants('parent', children, ['grandchild']), 1)
  assert.equal(activeDescendants('parent', children, ['child', 'sibling', 'grandchild']), 3)
  assert.equal(activeDescendants('manager', children, ['line']), 1)
  assert.equal(activeDescendants('parent', children, []), 0, '活动结束后提示消失')
  const cycle = { parent: ['child', 'child'], child: ['parent'] }
  assert.equal(activeDescendants('parent', cycle, ['child']), 1)
  assert.deepEqual(
    sessionTree('parent', cycle, new Set(), [], () => false).map((row) => row.id),
    ['parent', 'child'],
  )
})

test('真实模拟核心：经理工作线不在普通 active 集合，折叠提示仍从摘要读到未读和运行', async () => {
  const mock = mockChannel()
  const replica = createReplica(mock.channel)
  const stop = replica.start()
  try {
    await until(() => replica.store.get(keys.summary('local', 'manager-k2')), {
      what: '工作线目录',
    })
    const children = replica.store.get(keys.children('local'))
    const ids = descendantIds('m1', children)
    assert.ok(ids.includes('manager-k2'))
    assert.ok(!replica.store.get(keys.active('local')).includes('manager-k2'))
    const hasActivity = (id) => sessionHasActivity(replica.store.get(keys.summary('local', id)))
    assert.equal(hasActivity('manager-k2'), true)
    assert.ok(ids.filter(hasActivity).length > 0)
    await mock.channel.command('session.markRead', { deviceId: 'local', sessionId: 'manager-k2' })
    await until(() => !hasActivity('manager-k2'), { what: '工作线读完后提示更新' })
  } finally {
    stop()
    mock.close()
  }
})

test('折叠按设备和会话记在文件，重新载入仍保留；展开后清掉记录', async () => {
  const first = await import('../src/screens/sessions/folds.ts?recent-tree-first')
  first.toggleFolded('recent:d', 'folded', 'parent')
  assert.deepEqual(first.foldsOf('recent:d').folded, ['parent'])
  assert.deepEqual(first.foldsOf('d').folded, [], '不改变设备会话列表的开合')
  assert.deepEqual(first.foldsOf('other').folded, [])
  const again = await import('../src/screens/sessions/folds.ts?recent-tree-again')
  assert.deepEqual(again.foldsOf('recent:d').folded, ['parent'])
  again.toggleFolded('recent:d', 'folded', 'parent')
  assert.deepEqual(again.foldsOf('recent:d').folded, [])
})

test('经理、工作线和普通子对话都打开所点会话的详情', () => {
  for (const sessionId of ['manager', 'line', 'child', 'grandchild']) {
    const row = { deviceId: 'd', sessionId, workspaceId: 'w', at: 20 }
    assert.deepEqual(recentRoute(row, sessionId), [
      'Detail',
      { deviceId: 'd', sessionId, title: sessionId },
    ])
  }
})

test('置顶、最近、未读项目默认收起，用户选择跨重载保留且分区隔离', async () => {
  const { groupClosed, NO_DEVICE_FOLDS } = await import('../../../packages/ui/src/sidebar/folds.ts')
  const first = await import('../src/screens/sessions/folds.ts?project-fold-first')
  for (const scope of ['device', 'pins:device', 'recent:device', 'unread:device']) {
    assert.equal(groupClosed(first.foldsOf(scope), 'project', true), true)
    first.toggleFolded(scope, 'closed', 'project', true)
    assert.equal(groupClosed(first.foldsOf(scope), 'project', true), false)
  }
  const again = await import('../src/screens/sessions/folds.ts?project-fold-reloaded')
  assert.equal(groupClosed(again.foldsOf('device'), 'project', true), false)
  again.toggleFolded('recent:device', 'closed', 'project', true)
  const third = await import('../src/screens/sessions/folds.ts?project-fold-third')
  assert.equal(groupClosed(third.foldsOf('recent:device'), 'project', true), true)
  assert.equal(groupClosed(third.foldsOf('unread:device'), 'project', true), false)
  assert.equal(groupClosed(NO_DEVICE_FOLDS, 'project'), false)
})
