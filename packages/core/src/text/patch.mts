// 把统一格式的差异（git diff 的输出，或者 harness 给的本回合差异）拆成一个个文件、一段段改动。纯函数。
// 认的是 git 的写法：diff --git 开头的文件头、改名、权限、二进制、新增、删除，以及只有 ---/+++ 的朴素写法。
// 段里的行按 @@ 里写的行数去数，不靠“下一行长得像不像文件头”来断：文件的内容里什么都可能有。
import type { DiffHunk } from '../model-diff.mjs'
import { decodeUtf8 } from './bytes.mjs'

export interface PatchFile {
  /** 新的名字；删掉的文件是它原来的名字 */
  path: string
  /** 改名、复制之前的名字 */
  from: string | null
  change: 'modify' | 'add' | 'delete' | 'rename' | 'copy'
  binary: boolean
  mode: { from: string; to: string } | null
  hunks: DiffHunk[]
  noEolOld: boolean
  noEolNew: boolean
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

const SIMPLE: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/**
 * git 把名字里有特殊字符的路径写成带引号的 C 字符串（"a/\346\226\207.txt"）。还原成原来的字。
 * 没带引号的原样返回
 */
export function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const bytes: number[] = []
  const body = text.slice(1, -1)
  for (let at = 0; at < body.length; at++) {
    const char = body.charAt(at)
    if (char !== '\\') {
      // 引号里没转义的都是 ASCII 之外原样带过来的字：按 UTF-8 放回去
      const code = body.codePointAt(at) ?? 0
      if (code > 0xffff) at++
      if (code < 0x80) bytes.push(code)
      else bytes.push(...utf8Of(code))
      continue
    }
    const next = body.charAt(at + 1)
    const octal = /^[0-7]{1,3}/.exec(body.slice(at + 1))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff)
      at += octal[0].length
    } else if (SIMPLE[next] !== undefined) {
      bytes.push(SIMPLE[next])
      at++
    } else {
      bytes.push(92)
    }
  }
  return decodeUtf8(Uint8Array.from(bytes))
}

function utf8Of(code: number): number[] {
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
  if (code < 0x10000) {
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
  }
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ]
}

/** “--- a/x”“+++ b/y” 后面的名字：去掉前缀，/dev/null 是没有这一边 */
function sideName(rest: string, prefix: 'a/' | 'b/'): string | null {
  // 没带引号的名字后面可能跟着一个制表符（名字里有空格时 git 会加），或者别的工具写的时间
  const cut = rest.startsWith('"') ? rest : (rest.split('\t')[0] ?? rest)
  const name = unquotePath(cut.trimEnd())
  if (name === '/dev/null') return null
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** “diff --git a/x b/y” 里的两个名字。认不出来（名字里带 “ b/” 又改了名）是 null，靠后面的行补 */
function gitHeaderNames(rest: string): { from: string; to: string } | null {
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest)
    if (!match) return null
    const from = unquotePath(match[1] ?? '')
    const to = unquotePath(match[2] ?? '')
    return { from: from.replace(/^a\//, ''), to: to.replace(/^b\//, '') }
  }
  // 没改名的时候两边的名字一样：按长度对半分，不怕名字里有空格
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half)) {
    const left = rest.slice(0, half)
    const right = rest.slice(half + 1)
    if (
      rest.charAt(half) === ' ' &&
      left.startsWith('a/') &&
      right.startsWith('b/') &&
      left.slice(2) === right.slice(2)
    ) {
      return { from: left.slice(2), to: right.slice(2) }
    }
  }
  const at = rest.indexOf(' b/')
  if (rest.startsWith('a/') && at > 0 && rest.indexOf(' b/', at + 1) < 0) {
    return { from: rest.slice(2, at), to: rest.slice(at + 3) }
  }
  const quoted = /^(\S.*) ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quoted) {
    return {
      from: (quoted[1] ?? '').replace(/^a\//, ''),
      to: unquotePath(quoted[2] ?? '').replace(/^b\//, ''),
    }
  }
  return null
}

interface Draft {
  header: { from: string; to: string } | null
  minus: string | null | undefined
  plus: string | null | undefined
  renameFrom: string | null
  renameTo: string | null
  copy: boolean
  added: boolean
  deleted: boolean
  binary: boolean
  oldMode: string | null
  newMode: string | null
  hunks: DiffHunk[]
  noEolOld: boolean
  noEolNew: boolean
  adds: number
  dels: number
}

const blank = (header: Draft['header']): Draft => ({
  header,
  minus: undefined,
  plus: undefined,
  renameFrom: null,
  renameTo: null,
  copy: false,
  added: false,
  deleted: false,
  binary: false,
  oldMode: null,
  newMode: null,
  hunks: [],
  noEolOld: false,
  noEolNew: false,
  adds: 0,
  dels: 0,
})

function finish(draft: Draft): PatchFile | null {
  const from =
    draft.renameFrom ?? (draft.minus === undefined ? draft.header?.from : draft.minus) ?? null
  const to = draft.renameTo ?? (draft.plus === undefined ? draft.header?.to : draft.plus) ?? null
  const added = draft.added || (draft.minus === null && draft.plus !== null && !draft.deleted)
  const deleted = draft.deleted || (draft.plus === null && draft.minus !== null && !draft.added)
  const path = (deleted ? (from ?? to) : (to ?? from)) ?? ''
  if (!path) return null
  const renamed = draft.renameFrom !== null && draft.renameTo !== null
  return {
    path,
    from: renamed ? draft.renameFrom : null,
    change: added
      ? 'add'
      : deleted
        ? 'delete'
        : renamed
          ? draft.copy
            ? 'copy'
            : 'rename'
          : 'modify',
    binary: draft.binary,
    mode:
      draft.oldMode && draft.newMode && draft.oldMode !== draft.newMode
        ? { from: draft.oldMode, to: draft.newMode }
        : null,
    hunks: draft.hunks,
    noEolOld: draft.noEolOld,
    noEolNew: draft.noEolNew,
    added: draft.adds,
    removed: draft.dels,
  }
}

export function parsePatch(text: string): PatchFile[] {
  const lines = text.split('\n')
  // 末尾的换行切出来的那个空串不是一行
  if (lines[lines.length - 1] === '') lines.pop()
  const files: PatchFile[] = []
  let draft: Draft | null = null
  const close = () => {
    const file = draft ? finish(draft) : null
    if (file) files.push(file)
    draft = null
  }
  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    if (line.startsWith('diff --git ')) {
      close()
      draft = blank(gitHeaderNames(line.slice('diff --git '.length)))
      at++
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk && draft) {
      at = readHunk(lines, at + 1, hunk, draft)
      continue
    }
    if (line.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ')) {
      // 朴素写法没有 diff --git 那一行：一对 ---/+++ 就是一个新文件
      if (!draft || draft.hunks.length > 0 || draft.minus !== undefined) {
        close()
        draft = blank(null)
      }
      draft.minus = sideName(line.slice(4), 'a/')
      draft.plus = sideName((lines[at + 1] ?? '').slice(4), 'b/')
      at += 2
      continue
    }
    if (draft) readHeaderLine(line, draft)
    at++
  }
  close()
  return files
}

/** 文件头里认得的那几种行：开头是什么、后面的字记到哪 */
const HEADER_LINES: readonly [string, (draft: Draft, value: string) => void][] = [
  [
    'rename from ',
    (draft, value) => {
      draft.renameFrom = unquotePath(value)
    },
  ],
  [
    'rename to ',
    (draft, value) => {
      draft.renameTo = unquotePath(value)
    },
  ],
  [
    'copy from ',
    (draft, value) => {
      draft.renameFrom = unquotePath(value)
      draft.copy = true
    },
  ],
  [
    'copy to ',
    (draft, value) => {
      draft.renameTo = unquotePath(value)
      draft.copy = true
    },
  ],
  [
    'new file mode ',
    (draft, value) => {
      draft.added = true
      draft.newMode = value.trim()
    },
  ],
  [
    'deleted file mode ',
    (draft, value) => {
      draft.deleted = true
      draft.oldMode = value.trim()
    },
  ],
  [
    'old mode ',
    (draft, value) => {
      draft.oldMode = value.trim()
    },
  ],
  [
    'new mode ',
    (draft, value) => {
      draft.newMode = value.trim()
    },
  ],
]

function readHeaderLine(line: string, draft: Draft): void {
  if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    draft.binary = true
    return
  }
  for (const [prefix, take] of HEADER_LINES) {
    if (!line.startsWith(prefix)) continue
    take(draft, line.slice(prefix.length))
    return
  }
}

/** 读一段。从 @@ 的下一行开始，照 @@ 里写的行数读；返回读到了哪一行 */
function readHunk(lines: string[], start: number, head: RegExpExecArray, draft: Draft): number {
  const hunk: DiffHunk = {
    oldStart: Number(head[1]),
    oldLines: head[2] === undefined ? 1 : Number(head[2]),
    newStart: Number(head[3]),
    newLines: head[4] === undefined ? 1 : Number(head[4]),
    section: head[5] ?? '',
    lines: [],
  }
  let oldLeft = hunk.oldLines
  let newLeft = hunk.newLines
  let at = start
  /** 上一行是哪一边的：后面跟着“\ No newline”时知道说的是谁 */
  let last = ' '
  while (at < lines.length) {
    const line = lines[at] ?? ''
    const mark = line.charAt(0)
    if (mark === '\\') {
      if (last === '-') draft.noEolOld = true
      else if (last === '+') draft.noEolNew = true
      else {
        draft.noEolOld = true
        draft.noEolNew = true
      }
      at++
      continue
    }
    if (oldLeft <= 0 && newLeft <= 0) break
    if (mark === '+' && newLeft > 0) {
      newLeft--
      draft.adds++
      hunk.lines.push(line)
    } else if (mark === '-' && oldLeft > 0) {
      oldLeft--
      draft.dels++
      hunk.lines.push(line)
    } else if ((mark === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
      // 有的工具会把只有一个空格的上下文行末尾的空格去掉：空行当成空的上下文
      oldLeft--
      newLeft--
      hunk.lines.push(line === '' ? ' ' : line)
    } else {
      // 对不上数了：这一段到此为止，剩下的交给外面当文件头看
      break
    }
    last = mark === '' ? ' ' : mark
    at++
  }
  draft.hunks.push(hunk)
  return at
}
