// 会话列表摊平（src/screens/sessions/list.ts）、差异摊成行（src/screens/tools/diff/rows.ts）、
// 终端挑哪一个（src/screens/tools/terminal/pick.ts）：页面里不靠画面就能算的那几件事。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupOfSection, LOOSE, PINNED } from '@litch/core'
import { buildList, groupKeyOf, PROJECTS } from '../src/screens/sessions/list.ts'
import { rowsOf, splitPath } from '../src/screens/tools/diff/rows.ts'
import { nextAfterClose, pickExisting, workspaceOf } from '../src/screens/tools/terminal/pick.ts'

const section = { id: 'sec', name: '分区' }
const workspace = (id, roots = [`/w/${id}`], place = {}) => ({
  id,
  name: id,
  roots,
  pinned: false,
  sectionId: null,
  ...place,
})

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
  organizable: true,
  children: {},
  hidden: [],
  folded: new Set(),
  always: () => false,
  ...over,
})

test('会话列表的顺序：置顶、分区、“项目”（里面的工作区没有会话也有标题）、散的，最后是归档的标题', () => {
  const items = buildList(input())
  assert.deepEqual(
    items.map((item) => item.key),
    [
      `g:${PINNED}`,
      's:p1',
      `g:${groupOfSection('sec')}`,
      's:s1',
      's:s2',
      `g:${PROJECTS}`,
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
  const inner = items.filter((item) => item.type === 'group' && item.inner).map((item) => item.key)
  assert.deepEqual(inner, ['g:w1', 'g:w2'], '“项目”里的工作区往里缩')
  assert.deepEqual(items.find((item) => item.key === `g:${PROJECTS}`).tally, ['w1', 'w2'])
})

test('工作区排在它所在的那一组里：置顶的在置顶里、进了分区的在分区里，其余的在“项目”里', () => {
  const items = buildList(
    input({
      groups: { [groupOfSection('sec')]: ['s1'], w1: ['a'], w2: ['b'], w3: [] },
      workspaces: [
        workspace('w1', undefined, { sectionId: 'sec' }),
        workspace('w2', undefined, { pinned: true }),
        workspace('w3'),
      ],
    }),
  )
  assert.deepEqual(
    items.map((item) => item.key),
    [
      `g:${PINNED}`,
      'g:w2',
      's:b',
      `g:${groupOfSection('sec')}`,
      's:s1',
      'g:w1',
      's:a',
      `g:${PROJECTS}`,
      'g:w3',
      'a:head',
    ],
  )
})

test('收起的组只剩标题行（还带着数目）；收起“项目”连里面的工作区一起收起；空的置顶和散的组不画', () => {
  const items = buildList(input({ collapsed: new Set(['w1']), groups: { w1: ['a', 'b'], w2: [] } }))
  assert.deepEqual(
    items.map((item) => item.key),
    [`g:${PROJECTS}`, 'g:w1', 'g:w2', 'a:head'],
  )
  assert.equal(items[1].count, 2)
  assert.equal(items[1].collapsed, true)
  const shut = buildList(input({ collapsed: new Set([PROJECTS]), groups: { w1: ['a'] } }))
  assert.deepEqual(
    shut.map((item) => item.key),
    [`g:${PROJECTS}`, 'a:head'],
  )
  assert.equal(shut[0].collapsed, true)
})

test('“项目”：能整理的设备上空着也有标题（好在那里添加）；整理不了又没有工作区的不画', () => {
  const empty = { groups: {}, workspaces: [] }
  assert.deepEqual(
    buildList(input(empty)).map((item) => item.key),
    [`g:${PROJECTS}`, 'a:head'],
  )
  assert.deepEqual(
    buildList(input({ ...empty, organizable: false })).map((item) => item.key),
    ['a:head'],
  )
})

test('归档那一段：没取到时按在不在线说“加载中”或“离线”，取到了是空或一条条', () => {
  const note = (over) => buildList(input({ archivedOpen: true, ...over })).at(-1)
  assert.equal(note({}).note, 'loading')
  assert.equal(note({ offline: true }).note, 'offline')
  assert.equal(note({ archived: [] }).note, 'empty')
  const last = note({ archived: [{ id: 'old' }] })
  assert.deepEqual([last.type, last.key], ['archived', 'a:old'])
})

const sessionRows = (items) =>
  items
    .filter((item) => item.type === 'session')
    .map((item) => [item.id, item.depth, item.kids, item.folded])

test('会话树：子会话挂在父会话下面、一层缩一级，不在自己那一组里另占一行；兄弟照核心给的先后', () => {
  const items = buildList(
    input({
      groups: { w1: ['p', 'c2', 'x'], w2: ['c1'], [LOOSE]: ['g1'] },
      children: { p: ['c1', 'c2'], c1: ['g1'] },
    }),
  )
  assert.deepEqual(sessionRows(items), [
    ['p', 0, 2, false],
    ['c1', 1, 1, false],
    ['g1', 2, 0, false],
    ['c2', 1, 0, false],
    ['x', 0, 0, false],
  ])
  // 子会话都挂走了的组照样有标题（和桌面侧栏一样），数目还算着它们
  const w2 = items.find((item) => item.key === 'g:w2')
  assert.equal(w2.count, 1)
  assert.equal(
    items.findIndex((item) => item.key === 'g:w2') + 1,
    items.findIndex((item) => item.key === `g:${LOOSE}`),
    'w2 下面没有会话行',
  )
})

test('会话树：父会话不在列表里（藏起来了）的子会话照常排在自己那一组；父会话在收起的组里，子会话跟着收起', () => {
  const groups = { w1: ['p'], w2: ['c'] }
  const children = { p: ['c'] }
  const gone = buildList(input({ groups, children, hidden: ['p'] }))
  assert.deepEqual(sessionRows(gone), [['c', 0, 0, false]])
  const shut = buildList(input({ groups, children, collapsed: new Set(['w1']) }))
  assert.deepEqual(sessionRows(shut), [])
})

test('会话树：收起了的父会话下面只露出停下来等人的；默认都展开', () => {
  const groups = { w1: ['p'] }
  const children = { p: ['c1', 'c2'] }
  assert.deepEqual(sessionRows(buildList(input({ groups, children }))).length, 3)
  const folded = buildList(
    input({ groups, children, folded: new Set(['p']), always: (id) => id === 'c2' }),
  )
  assert.deepEqual(sessionRows(folded), [
    ['p', 0, 2, true],
    ['c2', 1, 0, false],
  ])
})

test('派出来的会话：藏着时整个不画、不算数，只有它们的工作区不出；等人的照露', () => {
  const groups = { w1: ['p', 'n1'], w2: ['n2'], [LOOSE]: ['n3'] }
  const children = { p: ['n1'] }
  const hidden = ['n1', 'n2', 'n3']
  const items = buildList(input({ groups, children, hidden }))
  assert.deepEqual(sessionRows(items), [['p', 0, 0, false]])
  assert.equal(items.find((item) => item.key === 'g:w1').count, 1)
  assert.equal(
    items.some((item) => item.key === 'g:w2'),
    false,
  )
  assert.equal(
    items.some((item) => item.key === `g:${LOOSE}`),
    false,
  )
  const waiting = buildList(input({ groups, children, hidden, always: (id) => id === 'n1' }))
  assert.deepEqual(sessionRows(waiting), [
    ['p', 0, 1, false],
    ['n1', 1, 0, false],
  ])
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
