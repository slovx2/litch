// 文件改动的差异（fileChange 条目里每个文件的 diff）的上限：太长的只留头尾，两刀都落在行与行之间，
// 中间省了几行、多少字记下来；画出来的行（diffLines）头尾两段和整段画出来的对应部分一模一样，行号接得上。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  countDiffLines,
  type DiffLine,
  diffLines,
  type FileChangeEntry,
  OUTPUT_KEEP,
  projectItem,
  utf8Length,
} from '../src/index.mjs'

/** 一次文件改动投影出来的那一个文件 */
function project(diff: string, kind: 'add' | 'update' | 'delete' = 'update'): FileChangeEntry {
  const item = projectItem({
    type: 'fileChange',
    id: 'f',
    status: 'completed',
    changes: [{ path: 'big.txt', kind: { type: kind, move_path: null }, diff }],
  } as ThreadItem)
  assert.ok(item.kind === 'fileChange')
  const [entry] = item.changes
  assert.ok(entry)
  return entry
}

/** 整段（没截过）画出来是什么样 */
const whole = (diff: string, entry: FileChangeEntry): DiffLine[] =>
  diffLines({ diff, diffKind: entry.diffKind, change: entry.change, elided: null })

/**
 * 截过的条目：留下的头尾是原文的头尾、都从行首起到行尾止，省掉的那段数得对；
 * 画出来的是整段画出来的开头一截、一行省略、末尾一截，行号和整段画的一样
 */
function checkCapped(diff: string, entry: FileChangeEntry): void {
  const { elided } = entry
  assert.ok(elided, '该截没截')
  const head = entry.diff
  const { tail } = elided
  assert.equal(diff.slice(0, head.length), head)
  assert.equal(diff.slice(diff.length - tail.length), tail)
  assert.ok(head === '' || head.endsWith('\n'), '开头那一截切在一行中间')
  const from = head.length
  const to = diff.length - tail.length
  assert.ok(to === diff.length || diff[to - 1] === '\n', '末尾那一截不是从行首起')
  const middle = diff.slice(from, to)
  assert.equal(elided.chars, middle.length)
  assert.equal(elided.bytes, utf8Length(middle))
  assert.equal(elided.lines, middle.split('\n').length - (middle.endsWith('\n') ? 1 : 0))
  const size = JSON.stringify(entry).length
  assert.ok(size <= OUTPUT_KEEP + 10_000, `条目有 ${size} 个字`)

  const drawn = diffLines(entry)
  const gaps = drawn.filter((line) => line.type === 'gap')
  assert.deepEqual(gaps, [
    { type: 'gap', text: '', oldNo: null, newNo: null, lines: elided.lines, bytes: elided.bytes },
  ])
  const at = drawn.findIndex((line) => line.type === 'gap')
  const all = whole(diff, entry)
  const before = drawn.slice(0, at)
  const after = drawn.slice(at + 1)
  assert.deepEqual(before, all.slice(0, before.length), '开头那一截画得和整段的不一样')
  assert.deepEqual(
    after,
    all.slice(all.length - after.length),
    '末尾那一截画得和整段的不一样（行号接不上）',
  )
}

/** n 行的补丁：一个 @@ 里交替着删、加、不变的行 */
function patch(n: number, hunks = 1): string {
  const parts = ['--- a/big.txt', '+++ b/big.txt']
  const per = Math.ceil(n / hunks)
  let old = 1
  let fresh = 1
  for (let h = 0; h < hunks; h++) {
    const body: string[] = []
    let olds = 0
    let news = 0
    for (let i = 0; i < per; i++) {
      const tag = `${h}-${i} 第${i}行`
      if (i % 3 === 0) {
        body.push(`-old ${tag}`)
        olds++
      } else if (i % 3 === 1) {
        body.push(`+new ${tag}`)
        news++
      } else {
        body.push(` same ${tag}`)
        olds++
        news++
      }
    }
    parts.push(`@@ -${old},${olds} +${fresh},${news} @@`, ...body)
    old += olds + 10
    fresh += news + 10
  }
  return `${parts.join('\n')}\n`
}

test('差异：不到上限的原样留，没有省略', () => {
  const diff = patch(200)
  const entry = project(diff)
  assert.equal(entry.diff, diff)
  assert.equal(entry.elided, null)
})

test('差异：很长的补丁只留头尾，切在行与行之间，增删的行数按整段算，行号接得上', () => {
  const diff = patch(120_000)
  const entry = project(diff)
  checkCapped(diff, entry)
  const counts = countDiffLines(diff)
  assert.deepEqual({ added: entry.added, removed: entry.removed }, counts)
})

test('差异：省掉的那段里有好几个 @@ 时，末尾那一截的行号照它前面最近的 @@ 接着数', () => {
  const diff = patch(90_000, 40)
  checkCapped(diff, project(diff))
})

test('差异：一行长得找不到换行时，整行省掉，不留半行', () => {
  const huge = 'x'.repeat(3_000_000)
  const diff = `--- a/min.js\n+++ b/min.js\n@@ -1,1 +1,1 @@\n-${huge}\n+${huge}y\n`
  const entry = project(diff)
  checkCapped(diff, entry)
  // 两行都在省掉的那段里：画出来的只有 @@ 和一行省略
  assert.deepEqual(
    diffLines(entry).map((line) => line.type),
    ['hunk', 'gap'],
  )
})

test('差异：新增文件给的是整个内容时，末尾那一截的行号接着开头数', () => {
  const lines: string[] = []
  for (let n = 1; n <= 150_000; n++) lines.push(`第 ${n} 行 ${'·'.repeat(n % 7)}`)
  const diff = `${lines.join('\n')}\n`
  const entry = project(diff, 'add')
  assert.equal(entry.diffKind, 'content')
  checkCapped(diff, entry)
  assert.equal(entry.added, 150_000)
  const last = diffLines(entry).at(-1)
  assert.deepEqual(last, { type: 'add', text: lines.at(-1), oldNo: null, newNo: 150_000 })
})

test('差异：标成补丁却一个 @@ 都没有时，照上下文画，行号照样接得上', () => {
  const lines: string[] = []
  for (let n = 1; n <= 150_000; n++) lines.push(`行 ${n}`)
  const diff = lines.join('\n')
  checkCapped(diff, project(diff))
})
