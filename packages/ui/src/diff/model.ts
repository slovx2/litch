// 差异标签里不靠页面就能算的那部分：一次显示几个文件、变更文件树怎么摊成行、一个文件的差异怎么排成行
// （合并的、并排的）、展开上下文。纯函数，好单独测。
import type { DiffEntry, FileDiff } from '@litch/core'

/** 文件数和增删的总行数都不超过这两个数，才把全部文件接成一长条显示；超了就一次只看一个文件 */
export const TOGETHER_FILES = 100
export const TOGETHER_LINES = 6000
/** 一个文件增删超过这么多行就不画内容，只给摘要 */
export const FILE_LINES_MAX = 8000
/** 放差异的地方窄于这么多像素，并排改成合并（并排时一边不到 280 像素，一行看不了几个字） */
export const SPLIT_MIN_WIDTH = 560
/** 文件那一栏在左边时占多宽，像素。样式里要和它一样（diff.css 的 .dt） */
export const TREE_WIDTH = 220
/** 取差异时每段前后各带几行没改的（核心里 git diff 的 -U3） */
export const CONTEXT_LINES = 3
/** 展开上下文：隔着的行不超过 REVEAL_ALL 就全展开，多了每次两头各展开 REVEAL_STEP 行 */
export const REVEAL_STEP = 30
export const REVEAL_ALL = 60

export const changedLines = (entry: Pick<DiffEntry, 'added' | 'removed'>): number =>
  (entry.added ?? 0) + (entry.removed ?? 0)

export const tooBig = (entry: Pick<DiffEntry, 'added' | 'removed'>): boolean =>
  changedLines(entry) > FILE_LINES_MAX

/** together：全部文件接成一长条；single：一次一个 */
export type DiffMode = 'together' | 'single'

export function planOf(entries: readonly DiffEntry[], omitted: number): DiffMode {
  if (omitted > 0 || entries.length > TOGETHER_FILES) return 'single'
  let lines = 0
  for (const entry of entries) lines += changedLines(entry)
  return lines > TOGETHER_LINES ? 'single' : 'together'
}

export interface Totals {
  files: number
  added: number
  removed: number
}

export function totalsOf(entries: readonly DiffEntry[]): Totals {
  let added = 0
  let removed = 0
  for (const entry of entries) {
    added += entry.added ?? 0
    removed += entry.removed ?? 0
  }
  return { files: entries.length, added, removed }
}

// ---------- 变更文件树 ----------

export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; path: string; name: string; depth: number; entry: DiffEntry }

interface Dir {
  dirs: Map<string, Dir>
  files: DiffEntry[]
}

/**
 * 变了的文件按目录摊成行：目录在前，只有一个子目录、自己没有文件的目录和子目录并成一行（a/b/c）。
 * query 不空时只留路径里有这几个字的（不分大小写），而且全部展开；closed 是收起来的目录
 */
export function treeRows(
  entries: readonly DiffEntry[],
  query: string,
  closed: ReadonlySet<string>,
): TreeRow[] {
  const needle = query.trim().toLowerCase()
  const root: Dir = { dirs: new Map(), files: [] }
  for (const entry of entries) {
    if (needle && !entry.path.toLowerCase().includes(needle)) continue
    const parts = entry.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.push(entry)
  }
  const rows: TreeRow[] = []
  const walk = (dir: Dir, prefix: string, depth: number) => {
    for (const [first, child] of [...dir.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      let name = first
      let node = child
      // 一条独苗的目录链并成一行
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[only, next]] = [...node.dirs] as [[string, Dir]]
        name = `${name}/${only}`
        node = next
      }
      const path = prefix + name
      const open = needle !== '' || !closed.has(path)
      rows.push({ kind: 'dir', path, name, depth, open })
      if (open) walk(node, `${path}/`, depth + 1)
    }
    for (const entry of dir.files) {
      rows.push({
        kind: 'file',
        path: entry.path,
        name: entry.path.slice(prefix.length),
        depth,
        entry,
      })
    }
  }
  walk(root, '', 0)
  return rows
}

// ---------- 一个文件的差异排成行 ----------

/** 一边的一行。at：它是这一边的第几行（从 0 起，按这份差异里出现的顺序），上色的结果按它对 */
export interface Cell {
  no: number
  text: string
  at: number
}

export type DiffRow =
  /** 两段之间隔着没显示的行。hidden 是 null：不知道有多少（文件末尾，还没取整个文件） */
  | { kind: 'gap'; id: string; gap: number; hidden: number | null; section: string }
  | { kind: 'line'; id: string; sign: ' ' | '+' | '-'; old: Cell | null; next: Cell | null }
  /** 并排的一行：左边是旧的，右边是新的，缺的那边空着 */
  | { kind: 'pair'; id: string; sign: ' ' | '~'; old: Cell | null; next: Cell | null }
  /** “末尾没有换行”的说明 */
  | { kind: 'eol'; id: string; side: 'old' | 'next' }

/** 一份差异摊平：每一行带上两边的行号 */
interface Flat {
  sign: ' ' | '+' | '-'
  text: string
  old: Cell | null
  next: Cell | null
}

/** 每一段开头的那一行在摊平之后是第几个，连同这一段的“所在函数” */
interface Flattened {
  lines: Flat[]
  starts: { at: number; section: string }[]
}

function flatten(file: FileDiff): Flattened {
  const lines: Flat[] = []
  const starts: Flattened['starts'] = []
  let oldAt = 0
  let nextAt = 0
  for (const hunk of file.hunks) {
    starts.push({ at: lines.length, section: hunk.section })
    let oldNo = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0)
    let nextNo = hunk.newStart + (hunk.newLines === 0 ? 1 : 0)
    for (const raw of hunk.lines) {
      const mark = raw.charAt(0)
      const sign = mark === '+' || mark === '-' ? mark : ' '
      const text = raw.slice(1)
      lines.push({
        sign,
        text,
        old: sign === '+' ? null : { no: oldNo++, text, at: oldAt++ },
        next: sign === '-' ? null : { no: nextNo++, text, at: nextAt++ },
      })
    }
  }
  return { lines, starts }
}

/** 两边各自的全部行，按出现的顺序。上色时一边一份 */
export function sideLines(file: FileDiff): { old: string[]; next: string[] } {
  const old: string[] = []
  const next: string[] = []
  for (const line of flatten(file).lines) {
    if (line.old) old.push(line.text)
    if (line.next) next.push(line.text)
  }
  return { old, next }
}

/** 展开上下文之后看得见的范围：整个文件摊平后的下标，[从, 到)，从小到大、互不相接 */
export type Ranges = readonly (readonly [number, number])[]

const merged = (ranges: [number, number][]): [number, number][] => {
  const out: [number, number][] = []
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else if (to > from) out.push([from, to])
  }
  return out
}

/**
 * 原来那几段在“带着整个文件的那一份”里各占哪一截。base 是只带三行上下文的，full 是带着整个文件的
 */
export function rangesOf(base: FileDiff, full: FileDiff): [number, number][] {
  const lines = flatten(full).lines
  const ranges: [number, number][] = []
  let cursor = 0
  for (const hunk of base.hunks) {
    const oldNo = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0)
    const nextNo = hunk.newStart + (hunk.newLines === 0 ? 1 : 0)
    // 这一段的第一行：两边的行号都对得上的那一个
    let at = cursor
    while (at < lines.length) {
      const line = lines[at] as Flat
      const first = hunk.lines[0]?.charAt(0)
      const hit =
        first === '+'
          ? line.sign === '+' && line.next?.no === nextNo
          : first === '-'
            ? line.sign === '-' && line.old?.no === oldNo
            : line.sign === ' ' && line.old?.no === oldNo && line.next?.no === nextNo
      if (hit) break
      at++
    }
    if (at >= lines.length) continue
    ranges.push([at, Math.min(lines.length, at + hunk.lines.length)])
    cursor = at + hunk.lines.length
  }
  return merged(ranges)
}

/** 点了第 gap 个间隔上的“展开”：间隔不大就全展开，大的两头各展开一截 */
export function reveal(ranges: Ranges, gap: number, total: number): [number, number][] {
  const next = ranges.map(([from, to]): [number, number] => [from, to])
  const before = next[gap - 1]
  const after = next[gap]
  const from = before ? before[1] : 0
  const to = after ? after[0] : total
  if (to - from <= REVEAL_ALL) next.push([from, to])
  else {
    if (before) next.push([from, from + REVEAL_STEP])
    if (after) next.push([to - REVEAL_STEP, to])
    // 文件开头、末尾的间隔只有一头挨着差异
    if (!before && !after) next.push([from, from + REVEAL_STEP])
  }
  return merged(next)
}

/** 一截摊平的行排成界面上的行 */
function emit(rows: DiffRow[], lines: readonly Flat[], split: boolean) {
  if (!split) {
    for (const line of lines) {
      const id = `${line.old?.no ?? ''}:${line.next?.no ?? ''}`
      rows.push({ kind: 'line', id, sign: line.sign, old: line.old, next: line.next })
    }
    return
  }
  let at = 0
  while (at < lines.length) {
    const line = lines[at] as Flat
    if (line.sign === ' ') {
      rows.push({
        kind: 'pair',
        id: `${line.old?.no}:${line.next?.no}`,
        sign: ' ',
        old: line.old,
        next: line.next,
      })
      at++
      continue
    }
    // 一段改动：删的排左边，加的排右边，一一对着；多出来的那边单着
    const minus: Flat[] = []
    const plus: Flat[] = []
    while (at < lines.length && lines[at]?.sign === '-') minus.push(lines[at++] as Flat)
    while (at < lines.length && lines[at]?.sign === '+') plus.push(lines[at++] as Flat)
    for (let n = 0; n < Math.max(minus.length, plus.length); n++) {
      const old = minus[n]?.old ?? null
      const next = plus[n]?.next ?? null
      rows.push({ kind: 'pair', id: `${old?.no ?? ''}:${next?.no ?? ''}`, sign: '~', old, next })
    }
  }
}

/**
 * 一个文件的差异排成行。ranges 不是 null：file 是带着整个文件的那一份，只显示 ranges 里的那些行，
 * 中间隔着的地方各出一行“还有多少行没显示”。ranges 是 null：file 里有几段就显示几段
 */
export function rowsOf(file: FileDiff, split: boolean, ranges: Ranges | null): DiffRow[] {
  const { lines, starts } = flatten(file)
  const rows: DiffRow[] = []
  const last = lines[lines.length - 1]
  const tail = () => {
    if (!last) return
    if (last.old && file.noEolOld) rows.push({ kind: 'eol', id: 'eol-old', side: 'old' })
    if (last.next && file.noEolNew) rows.push({ kind: 'eol', id: 'eol-next', side: 'next' })
  }
  if (ranges) {
    let done = 0
    ranges.forEach(([from, to], index) => {
      if (from > done) {
        rows.push({ kind: 'gap', id: `gap-${index}`, gap: index, hidden: from - done, section: '' })
      }
      emit(rows, lines.slice(from, to), split)
      done = to
    })
    if (done < lines.length) {
      rows.push({
        kind: 'gap',
        id: `gap-${ranges.length}`,
        gap: ranges.length,
        hidden: lines.length - done,
        section: '',
      })
    } else tail()
    return rows
  }
  // 整个文件都在这一份里（新加的、删掉的、本来就带着全部上下文的）：前后没有藏着的行
  const whole =
    file.full ||
    (file.hunks.length === 1 && (file.hunks[0]?.oldLines === 0 || file.hunks[0]?.newLines === 0))
  let oldEnd = 0
  starts.forEach((start, index) => {
    const to = starts[index + 1]?.at ?? lines.length
    const chunk = lines.slice(start.at, to)
    // 这一段第一行之前、上一段最后一行之后隔着多少行（按旧的那边的行号算）
    const before = chunk.find((line) => line.old)?.old?.no ?? oldEnd + 1
    const hidden = Math.max(0, before - oldEnd - 1)
    if (!whole && hidden > 0) {
      rows.push({ kind: 'gap', id: `gap-${index}`, gap: index, hidden, section: start.section })
    }
    emit(rows, chunk, split)
    for (const line of chunk) if (line.old) oldEnd = line.old.no
  })
  // 最后一段后面跟着的没改的行不到 CONTEXT_LINES 行，或者注明了末尾没有换行：差异已经带到文件末尾了，后面没有藏着的行
  let trailing = 0
  for (let at = lines.length - 1; at >= 0 && lines[at]?.sign === ' '; at--) trailing++
  const atEnd = trailing < CONTEXT_LINES || file.noEolOld || file.noEolNew
  if (!whole && !atEnd && lines.length > 0) {
    rows.push({
      kind: 'gap',
      id: `gap-${starts.length}`,
      gap: starts.length,
      hidden: null,
      section: '',
    })
  } else tail()
  return rows
}

/** 最长的一行有多少字：不折行的时候按它估内容有多宽 */
export function longestOf(file: FileDiff): { old: number; next: number } {
  let old = 0
  let next = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const size = line.length - 1
      if (line.charAt(0) !== '+' && size > old) old = size
      if (line.charAt(0) !== '-' && size > next) next = size
    }
  }
  return { old, next }
}

/**
 * 整个文件只有加的行，或者只有删的行（新文件、删掉的文件）：并排着看的话另一边全是空的，
 * 白占一半的地方，所以这种文件并排时也照合并的排
 */
export function oneSided(file: FileDiff): boolean {
  let added = false
  let removed = false
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const sign = line.charAt(0)
      if (sign === '+') added = true
      else if (sign === '-') removed = true
      else return false
    }
  }
  return added !== removed
}

/** 这份差异里最大的行号：行号那一栏照它的位数留宽度 */
export function lastLineOf(file: FileDiff): number {
  let last = 0
  for (const hunk of file.hunks) {
    last = Math.max(last, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
  }
  return last
}

/** 这一行在某一边能被批注的那个格子：没改的行算改动后的那边，删掉的行算改动前的那边 */
export function cellOf(row: DiffRow, side: 'old' | 'next'): Cell | null {
  if (row.kind === 'line') {
    return side === 'old' ? (row.sign === '-' ? row.old : null) : row.sign === '-' ? null : row.next
  }
  if (row.kind === 'pair') return side === 'old' ? (row.sign === '~' ? row.old : null) : row.next
  return null
}

/** 某一边第 from 到 to 行的原文（这份差异里有的那些） */
export function linesIn(file: FileDiff, side: 'old' | 'next', from: number, to: number): string[] {
  const out: string[] = []
  for (const line of flatten(file).lines) {
    const cell = side === 'old' ? (line.sign === '-' ? line.old : null) : line.next
    if (cell && cell.no >= from && cell.no <= to) out.push(cell.text)
  }
  return out
}
