// 会话列表摊平（src/screens/sessions/list.ts）、差异摊成行（src/screens/tools/diff/rows.ts）、
// 终端挑哪一个（src/screens/tools/terminal/pick.ts）：页面里不靠画面就能算的那几件事。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupOfSection, LOOSE, PINNED } from '@litch/core'
import { buildList, groupKeyOf } from '../src/screens/sessions/list.ts'
import { rowsOf, splitPath } from '../src/screens/tools/diff/rows.ts'
import { nextAfterClose, pickExisting, workspaceOf } from '../src/screens/tools/terminal/pick.ts'

const section = { id: 'sec', name: '分区' }
const workspace = (id, roots = [`/w/${id}`]) => ({ id, name: id, roots })

const input = (over = {}) => ({
  groups: {
    [PINNED]: ['p1'],
    [groupOfSection('sec')]: ['s1', 's2'],
    w1: ['a'],
    w2: [],
    [LOOSE]: ['l1'],
  },
  sections: [section],
  workspaces: [workspace('w1'), workspace('w2')],
  collapsed: new Set(),
  archivedOpen: false,
  archived: null,
  offline: false,
  ...over,
})

test('会话列表的顺序：置顶、分区、工作区（没有会话也有标题）、散的，最后是归档的标题', () => {
  const items = buildList(input())
  assert.deepEqual(
    items.map((item) => item.key),
    [
      `g:${PINNED}`,
      's:p1',
      `g:${groupOfSection('sec')}`,
      's:s1',
      's:s2',
      'g:w1',
      's:a',
      'g:w2',
      `g:${LOOSE}`,
      's:l1',
      'a:head',
    ],
  )
  for (const item of items.filter((each) => each.type === 'group'))
    assert.equal(item.key, `g:${groupKeyOf(item.head)}`, '标题行的键和收起时记的键是同一个')
})

test('收起的组只剩标题行（还带着数目）；空的置顶和散的组不画', () => {
  const items = buildList(input({ collapsed: new Set(['w1']), groups: { w1: ['a', 'b'], w2: [] } }))
  assert.deepEqual(
    items.map((item) => item.key),
    ['g:w1', 'g:w2', 'a:head'],
  )
  assert.equal(items[0].count, 2)
  assert.equal(items[0].collapsed, true)
})

test('归档那一段：没取到时按在不在线说“加载中”或“离线”，取到了是空或一条条', () => {
  const note = (over) => buildList(input({ archivedOpen: true, ...over })).at(-1)
  assert.equal(note({}).note, 'loading')
  assert.equal(note({ offline: true }).note, 'offline')
  assert.equal(note({ archived: [] }).note, 'empty')
  const last = note({ archived: [{ id: 'old' }] })
  assert.deepEqual([last.type, last.key], ['archived', 'a:old'])
})

test('差异摊成行：段头的写法、两边的行号各自往下数，说明行不算一行', () => {
  const file = {
    hunks: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 1,
        section: 'function main()',
        lines: [' 留着', '-删掉一', '-删掉二', '\\ No newline at end of file'],
      },
      {
        oldStart: 40,
        oldLines: 1,
        newStart: 38,
        newLines: 2,
        section: '',
        lines: [' 上下文', '+新加'],
      },
    ],
  }
  const rows = rowsOf(file)
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'hunk' ? row.text : `${row.sign}${row.old ?? '_'}/${row.next ?? '_'}`,
    ),
    [
      '@@ -10,3 +10 @@ function main()',
      ' 10/10',
      '-11/_',
      '-12/_',
      '@@ -40 +38,2 @@',
      ' 40/38',
      '+_/39',
    ],
  )
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, '行的键不重复')
  assert.deepEqual(splitPath('src/a/b.ts'), { dir: 'src/a/', name: 'b.ts' })
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' })
})

test('终端：根目录归哪个工作区（末尾的斜杠不算）、挑同目录里最后开的活着的、关掉后换到哪个', () => {
  const spaces = [workspace('w1', ['/w/one/']), workspace('w2', ['/w/two', '/w/two-b'])]
  assert.equal(workspaceOf(spaces, '/w/one'), 'w1')
  assert.equal(workspaceOf(spaces, '/w/two-b/'), 'w2')
  assert.equal(workspaceOf(spaces, '/w/three'), null)
  assert.equal(workspaceOf(undefined, '/w/one'), null)

  const infos = {
    t1: { state: 'running', cwd: '/w/one' },
    t2: { state: 'exited', cwd: '/w/one' },
    t3: { state: 'away', cwd: '/w/two' },
  }
  const infoOf = (id) => infos[id]
  assert.equal(pickExisting(['t1', 't2', 't3'], infoOf, '/w/one'), 't1', '退出了的不挑')
  assert.equal(pickExisting(['t1', 't2', 't3'], infoOf, null), 't3')
  assert.equal(pickExisting(['t2'], infoOf, '/w/one'), null)

  assert.equal(nextAfterClose(['a', 'b', 'c'], 'b'), 'c')
  assert.equal(nextAfterClose(['a', 'b', 'c'], 'c'), 'b')
  assert.equal(nextAfterClose(['a'], 'a'), null)
})
