// 一次文件改动的差异：太长时只留头尾（capDiff），以及拆成一行行、带上行号和增删标记给界面画（diffLines）。纯函数。
//
// 上限照命令输出的（output-cap.mts）：全文不到 OUTPUT_KEEP 个字整段留；到了就开头留 HEAD 个字上下、
// 末尾从 HEAD + k·STEP 处往后留。只多一条：两刀都落在行与行之间，差异是按行画的，切开一行画出来就是半行，
// 行号也对不上。所以开头那一刀往前找最近的换行，末尾那一刀往后找；一行长得前后都找不到换行（压缩过的脚本、
// 一整行的数据）就整行省掉，宁可多省一点。条目都是整段到的（条目完成、补丁更新、读历史），留下的只由全文决定。
// 省掉的那段记下行数、字数、UTF-8 字节数，和末尾那一截第一行的行号从几接着数（在 @@ 里面的话）。
import type { FileChangeEntry } from '../model.mjs'
import { OUTPUT_HEAD, OUTPUT_KEEP, ownText, tailStart, utf8Length } from './output-cap.mjs'

export type DiffLine =
  | {
      /** hunk 是 “@@ -a,b +c,d @@” 那一行 */
      type: 'add' | 'del' | 'ctx' | 'hunk'
      text: string
      oldNo: number | null
      newNo: number | null
    }
  /** 太长的差异中间省掉的那一段：省了几行、多少字节 */
  | { type: 'gap'; text: ''; oldNo: null; newNo: null; lines: number; bytes: number }

/** 读到哪了：下一行在旧、新两边各是第几行，在不在某个 @@ 里面 */
export interface DiffCursor {
  old: number
  new: number
  inHunk: boolean
}

/** 差异中间省掉的那一段 */
export interface DiffElision {
  /** 省掉了几行 */
  lines: number
  /** 省掉了多少个字（UTF-16 码元） */
  chars: number
  /** 省掉的部分有多少个 UTF-8 字节。给人看的是它 */
  bytes: number
  /** 省掉的部分之后、末尾留着的那一截，从一行的开头起 */
  tail: string
  /** 末尾那一截第一行的行号从几接着数 */
  resume: DiffCursor
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const START: DiffCursor = { old: 0, new: 0, inHunk: false }

/** text 里的一行行（按换行切，末尾的换行不多出一个空行），挨个交给 visit，不先切成数组 */
function eachLine(text: string, visit: (line: string) => void): void {
  let from = 0
  while (from < text.length) {
    const end = text.indexOf('\n', from)
    if (end < 0) {
      visit(text.slice(from))
      return
    }
    visit(text.slice(from, end))
    from = end + 1
  }
}

/**
 * 补丁的一行：从 cursor 往下读，更新 cursor，要画的话交给 out。
 * 第一个 @@ 之前是文件头（Index:、---、+++ 这些），“\ No newline at end of file” 这种说明行，都不画
 */
function stepPatch(line: string, cursor: DiffCursor, out?: DiffLine[]): void {
  const hunk = line.match(HUNK)
  if (hunk) {
    cursor.old = Number(hunk[1])
    cursor.new = Number(hunk[2])
    cursor.inHunk = true
    out?.push({ type: 'hunk', text: line, oldNo: null, newNo: null })
  } else if (!cursor.inHunk || line.startsWith('\\')) {
    // 不画
  } else if (line.startsWith('+')) {
    // 行号先记下再往下数：只读不画（out 没给）的时候也要数
    const newNo = cursor.new++
    out?.push({ type: 'add', text: line.slice(1), oldNo: null, newNo })
  } else if (line.startsWith('-')) {
    const oldNo = cursor.old++
    out?.push({ type: 'del', text: line.slice(1), oldNo, newNo: null })
  } else {
    const oldNo = cursor.old++
    const newNo = cursor.new++
    out?.push({ type: 'ctx', text: line.slice(1), oldNo, newNo })
  }
}

/** text 有几行。末尾的换行不多算一行 */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++
  return text.endsWith('\n') ? lines - 1 : lines
}

/** 截过的差异：文件改动条目上的这两个字段 */
export interface CappedDiff {
  /** 没省过时是全部；省过时是开头那一截（到一行的末尾为止） */
  diff: string
  elided: DiffElision | null
}

/**
 * 一整段差异按上限截好（规矩见文件开头）。kind 是 patch（统一格式的补丁）还是 content（整个文件的内容），
 * 末尾那一截的行号从几接着数要按它算
 */
export function capDiff(diff: string, kind: FileChangeEntry['diffKind']): CappedDiff {
  if (diff.length < OUTPUT_KEEP) return { diff, elided: null }
  // 开头那一刀：HEAD 之前最后一个换行之后；一个换行都没有就是 0
  const head = diff.lastIndexOf('\n', OUTPUT_HEAD - 1) + 1
  // 末尾那一刀：nominal 之后第一个换行之后（nominal 本来就在行首就是它）；找不到就是全文末尾，末尾一截是空的
  const nominal = tailStart(diff.length)
  const newline = diff[nominal - 1] === '\n' ? nominal - 1 : diff.indexOf('\n', nominal)
  const start = newline < 0 ? diff.length : newline + 1
  const middle = diff.slice(head, start)
  const resume = { ...START }
  if (kind === 'content') {
    resume.old = resume.new = countLines(diff.slice(0, head)) + countLines(middle) + 1
  } else {
    // 补丁里末尾那一截的行号要看前面最近的 @@ 和它之后有几行：前面整段走一遍（条目整段到时只算这一次）
    eachLine(diff.slice(0, start), (line) => stepPatch(line, resume))
  }
  return {
    diff: ownText(diff.slice(0, head)),
    elided: {
      lines: countLines(middle),
      chars: middle.length,
      bytes: utf8Length(middle),
      tail: ownText(diff.slice(start)),
      resume,
    },
  }
}

/** 一段内容（新增、删除的文件给的是整个内容）的一行行：新增的全是加，删除的全是减 */
function contentLines(text: string, removed: boolean, first: number, out: DiffLine[]): void {
  let no = first
  eachLine(text, (line) => {
    out.push({
      type: removed ? 'del' : 'add',
      text: line,
      oldNo: removed ? no : null,
      newNo: removed ? null : no,
    })
    no++
  })
}

/** 一个 @@ 都没有的“补丁”：原样按上下文画，总比什么都不显示强 */
function plainLines(text: string, first: number, out: DiffLine[]): void {
  let no = first
  eachLine(text, (line) => {
    out.push({ type: 'ctx', text: line, oldNo: no, newNo: no })
    no++
  })
}

export function diffLines(
  change: Pick<FileChangeEntry, 'diff' | 'diffKind' | 'change' | 'elided'>,
): DiffLine[] {
  const { diff, elided } = change
  const gap: DiffLine[] = elided
    ? [
        {
          type: 'gap',
          text: '',
          oldNo: null,
          newNo: null,
          lines: elided.lines,
          bytes: elided.bytes,
        },
      ]
    : []
  if (change.diffKind === 'content') {
    const removed = change.change === 'delete'
    const out: DiffLine[] = []
    contentLines(diff, removed, 1, out)
    out.push(...gap)
    if (elided) contentLines(elided.tail, removed, elided.resume.new, out)
    return out
  }
  const out: DiffLine[] = []
  const cursor = { ...START }
  eachLine(diff, (line) => stepPatch(line, cursor, out))
  out.push(...gap)
  // 末尾那一截接着省掉那段之后的行号读
  const rest = { ...(elided?.resume ?? START) }
  if (elided) eachLine(elided.tail, (line) => stepPatch(line, rest, out))
  if (cursor.inHunk || rest.inHunk) return out
  // 标成补丁但一个 @@ 都没有：照上下文画，行号按第几行数
  const plain: DiffLine[] = []
  plainLines(diff, 1, plain)
  plain.push(...gap)
  if (elided) plainLines(elided.tail, countLines(diff) + elided.lines + 1, plain)
  return plain
}
