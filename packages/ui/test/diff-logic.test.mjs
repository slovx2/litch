// 差异标签里不靠浏览器就能测的那部分：一次看几个文件、变更文件树、差异排成行（合并、并排）、展开上下文、
// 批注写成接在消息后面的那一段。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'

// 批注存在这台电脑上：给一个假的存储
const saved = new Map()
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => void saved.set(key, value),
}

const model = await import('../src/diff/model.ts')
const notes = await import('../src/diff/annotations.ts')

const entry = (path, added = 1, removed = 0, status = 'modified') => ({
  path,
  from: null,
  status,
  added,
  removed,
  binary: false,
  mode: null,
  staged: false,
  unstaged: true,
  dir: false,
})

const file = (hunks, more = {}) => ({
  path: 'a.ts',
  from: null,
  kind: 'text',
  hunks,
  full: false,
  language: 'typescript',
  noEolOld: false,
  noEolNew: false,
  added: 0,
  removed: 0,
  ...more,
})

test('一次看几个文件：文件数和总行数都不多才接成一长条；一个文件改得太多只给摘要', () => {
  const few = Array.from({ length: 100 }, (_, n) => entry(`f${n}.ts`, 30, 30))
  assert.equal(model.planOf(few, 0), 'together')
  assert.equal(model.planOf([...few, entry('one-more.ts')], 0), 'single')
  assert.equal(model.planOf([entry('big.ts', 4000, 2001)], 0), 'single')
  assert.equal(model.planOf([entry('a.ts')], 3), 'single')
  assert.equal(model.tooBig(entry('x', 8000, 0)), false)
  assert.equal(model.tooBig(entry('x', 8000, 1)), true)
  // 不知道行数的（二进制）不算行
  assert.deepEqual(
    model.totalsOf([entry('a', 2, 1), { ...entry('b'), added: null, removed: null }]),
    {
      files: 2,
      added: 2,
      removed: 1,
    },
  )
})

test('变更文件树：目录在前，独苗的目录并成一行；收起、筛选', () => {
  const entries = [
    entry('Makefile'),
    entry('cmd/tool/serve.go'),
    entry('cmd/tool/serve_test.go'),
    entry('docs/guide.md'),
    entry('docs/images/shot.png'),
    entry('packages/core/src/index.mts'),
  ]
  const brief = (rows) =>
    rows.map((row) => `${'  '.repeat(row.depth)}${row.kind === 'dir' ? `${row.name}/` : row.name}`)
  assert.deepEqual(brief(model.treeRows(entries, '', new Set())), [
    'cmd/tool/',
    '  serve.go',
    '  serve_test.go',
    'docs/',
    '  images/',
    '    shot.png',
    '  guide.md',
    'packages/core/src/',
    '  index.mts',
    'Makefile',
  ])
  const closed = model.treeRows(entries, '', new Set(['cmd/tool', 'docs/images']))
  assert.deepEqual(brief(closed), [
    'cmd/tool/',
    'docs/',
    '  images/',
    '  guide.md',
    'packages/core/src/',
    '  index.mts',
    'Makefile',
  ])
  assert.equal(closed[0].open, false)
  // 筛的时候收起的也展开；不分大小写
  assert.deepEqual(brief(model.treeRows(entries, 'SERVE', new Set(['cmd/tool']))), [
    'cmd/tool/',
    '  serve.go',
    '  serve_test.go',
  ])
  assert.deepEqual(model.treeRows(entries, 'nothing', new Set()), [])
})

const HUNKS = [
  {
    oldStart: 3,
    oldLines: 4,
    newStart: 3,
    newLines: 5,
    section: 'fn a()',
    lines: [' c', '-d', '+D', '+D2', ' e', ' f'],
  },
  { oldStart: 20, oldLines: 3, newStart: 21, newLines: 2, section: '', lines: [' t', '-u', ' v'] },
]

test('排成行：合并的一行一个记号，行号两边各算各的；段之间写着隔了多少行', () => {
  const rows = model.rowsOf(file(HUNKS), false, null)
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'gap'
        ? `gap ${row.hidden}`
        : `${row.sign}${row.old?.no ?? ''}:${row.next?.no ?? ''}`,
    ),
    // 最后一段后面只跟着一行没改的（不到三行）：差异已经到文件末尾了，后面不再有“展开”
    ['gap 2', ' 3:3', '-4:', '+:4', '+:5', ' 5:6', ' 6:7', 'gap 13', ' 20:21', '-21:', ' 22:22'],
  )
  // 后面跟满了三行没改的：文件多半还没完，末尾留一个不知道隔了多少行的“展开”
  const more = [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      section: '',
      lines: ['+new', ' a', ' b', ' c'],
    },
  ]
  assert.deepEqual(
    model.rowsOf(file(more), false, null).map((row) => row.kind),
    ['line', 'line', 'line', 'line', 'gap'],
  )
  assert.equal(model.rowsOf(file(more), false, null).at(-1).hidden, null)
  // 注明了末尾没有换行的：就是到末尾了
  assert.deepEqual(
    model.rowsOf(file(more, { noEolNew: true }), false, null).map((row) => row.kind),
    ['line', 'line', 'line', 'line', 'eol'],
  )
  // 上色按“这一边的第几行”对
  assert.deepEqual(model.sideLines(file(HUNKS)), {
    old: ['c', 'd', 'e', 'f', 't', 'u', 'v'],
    next: ['c', 'D', 'D2', 'e', 'f', 't', 'v'],
  })
  assert.equal(rows[4].next.at, 2)
  assert.deepEqual(model.longestOf(file(HUNKS)), { old: 1, next: 2 })
})

test('排成行：并排的，删的在左加的在右一一对着，多出来的单着', () => {
  const rows = model.rowsOf(file(HUNKS), true, null).filter((row) => row.kind === 'pair')
  assert.deepEqual(
    rows.map((row) => `${row.sign}${row.old?.text ?? '∅'}|${row.next?.text ?? '∅'}`),
    [' c|c', '~d|D', '~∅|D2', ' e|e', ' f|f', ' t|t', '~u|∅', ' v|v'],
  )
})

test('只有一边有内容的文件（新加的、删掉的）认得出来；行号那一栏照最大的行号留宽度', () => {
  const hunk = (lines, at = 1) => ({
    oldStart: at,
    oldLines: lines.filter((line) => line[0] !== '+').length,
    newStart: at,
    newLines: lines.filter((line) => line[0] !== '-').length,
    section: '',
    lines,
  })
  assert.equal(model.oneSided(file([hunk(['+a', '+b'])])), true)
  assert.equal(model.oneSided(file([hunk(['-a']), hunk(['-b'], 40)])), true)
  // 两边都有：改了的、带着没改的行的
  assert.equal(model.oneSided(file([hunk(['-a', '+b'])])), false)
  assert.equal(model.oneSided(file([hunk([' a', '+b'])])), false)
  // 没有内容的不算
  assert.equal(model.oneSided(file([])), false)
  assert.equal(model.lastLineOf(file(HUNKS)) >= 1, true)
  assert.equal(model.lastLineOf(file([hunk(['+a', ' b', ' c'], 998)])), 1001)
  assert.equal(model.lastLineOf(file([])), 0)
})

test('整个文件都在里面的（新加的、删掉的）前后没有藏着的行；末尾没有换行另起一行说明', () => {
  const added = file(
    [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, section: '', lines: ['+a', '+b'] }],
    {
      noEolNew: true,
    },
  )
  assert.deepEqual(
    model.rowsOf(added, false, null).map((row) => row.kind),
    ['line', 'line', 'eol'],
  )
})

test('展开上下文：原来的段在整个文件里各占哪一截；间隔小的全展开，大的两头各展开一截', () => {
  // 整个文件：100 行，第 10 行改了、第 80 行删了
  const lines = []
  for (let n = 1; n <= 100; n++) {
    if (n === 10) lines.push('-old10', '+new10')
    else if (n === 80) lines.push('-old80')
    else lines.push(` l${n}`)
  }
  const full = file(
    [{ oldStart: 1, oldLines: 100, newStart: 1, newLines: 99, section: '', lines }],
    { full: true },
  )
  const base = file([
    {
      oldStart: 7,
      oldLines: 7,
      newStart: 7,
      newLines: 7,
      section: '',
      lines: [' l7', ' l8', ' l9', '-old10', '+new10', ' l11', ' l12', ' l13'],
    },
    {
      oldStart: 77,
      oldLines: 7,
      newStart: 77,
      newLines: 6,
      section: '',
      lines: [' l77', ' l78', ' l79', '-old80', ' l81', ' l82', ' l83'],
    },
  ])
  const ranges = model.rangesOf(base, full)
  assert.deepEqual(ranges, [
    [6, 14],
    [77, 84],
  ])
  const gaps = (list) =>
    model
      .rowsOf(full, false, list)
      .filter((row) => row.kind === 'gap')
      .map((row) => [row.gap, row.hidden])
  assert.deepEqual(gaps(ranges), [
    [0, 6],
    [1, 63],
    [2, 17],
  ])
  // 开头那 6 行：全展开
  const top = model.reveal(ranges, 0, lines.length)
  assert.deepEqual(top[0], [0, 14])
  // 中间隔着 63 行：两头各展开 30 行，还剩 3 行
  const middle = model.reveal(ranges, 1, lines.length)
  assert.deepEqual(middle, [
    [6, 44],
    [47, 84],
  ])
  assert.deepEqual(gaps(model.reveal(middle, 1, lines.length)), [
    [0, 6],
    [1, 17],
  ])
  // 末尾 17 行：全展开，后面就没有间隔了
  assert.deepEqual(gaps(model.reveal(ranges, 2, lines.length)).at(-1), [1, 63])
})

test('批注：按会话攒着，发消息时写成一段接在后面并清掉，没发成还回去', () => {
  const words = {
    title: (n) => `对改动的批注（${n} 条）：`,
    lines: (from, to) => (from === to ? `第 ${from} 行` : `第 ${from}–${to} 行`),
    old: '改动前的版本',
    next: '改动后的版本',
    comment: '批注：',
  }
  const key = notes.notesKey('local', 's1')
  notes.addNote(key, { path: 'src/a.ts', side: 'next', from: 4, to: 5, text: ' 这两行合成一行 ' }, [
    'D',
    'D2',
  ])
  notes.addNote(key, { path: 'src/a.ts', side: 'old', from: 21, to: 21, text: '为什么删？' }, [
    'u ``` x',
  ])
  notes.addNote(key, { path: 'x', side: 'next', from: 1, to: 1, text: '   ' }, [])
  assert.equal(notes.notesOf(key).length, 2)
  assert.equal(notes.notesOf(notes.notesKey('local', 's2')).length, 0)
  assert.ok(saved.get('litch.diff.notes').includes('src/a.ts'))
  const taken = notes.takeNotes(key, words)
  assert.equal(
    notes.withNotes('看一下这两处', taken.text),
    [
      '看一下这两处',
      '',
      '---',
      '对改动的批注（2 条）：',
      '',
      '1. `src/a.ts` 第 4–5 行（改动后的版本）',
      '```',
      'D',
      'D2',
      '```',
      '批注：这两行合成一行',
      '',
      '2. `src/a.ts` 第 21 行（改动前的版本）',
      '````',
      'u ``` x',
      '````',
      '批注：为什么删？',
    ].join('\n'),
  )
  assert.equal(notes.notesOf(key).length, 0)
  taken.restore()
  assert.equal(notes.notesOf(key).length, 2)
  notes.clearNotes(key)
  assert.equal(notes.withNotes('没有批注', notes.takeNotes(key, words).text), '没有批注')
})

test('能批注的格子：没改的行算改动后的那边，删掉的行算改动前的那边', () => {
  const rows = model.rowsOf(file(HUNKS), false, null)
  const context = rows[1]
  const removed = rows[2]
  assert.equal(model.cellOf(context, 'next').no, 3)
  assert.equal(model.cellOf(context, 'old'), null)
  assert.equal(model.cellOf(removed, 'old').no, 4)
  assert.equal(model.cellOf(removed, 'next'), null)
  assert.deepEqual(model.linesIn(file(HUNKS), 'next', 4, 6), ['D', 'D2', 'e'])
  assert.deepEqual(model.linesIn(file(HUNKS), 'old', 4, 21), ['d', 'u'])
})
