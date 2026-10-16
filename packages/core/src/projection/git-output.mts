// git 几条命令的输出怎么读，和怎么把它们合成差异面板的那张“变了哪些文件”的表。纯函数。
// 用的都是给程序读的格式（-z：记录之间用 NUL 隔开，路径原样、不加引号），不去读给人看的那种。
import type { DiffEntry, DiffScope, DiffStatus } from '../model-diff.mjs'

/** git status --porcelain=v2 里的一条 */
export interface StatusEntry {
  /** 相对于仓库顶层的路径 */
  path: string
  /** 改名之前的路径 */
  from: string | null
  /** changed：跟踪着的、有改动；untracked：没跟踪的；unmerged：合并冲突着 */
  kind: 'changed' | 'untracked' | 'unmerged'
  /** 暂存区相对于上一次提交：. 是没变，M、A、D、R、C、T 是各种改动 */
  x: string
  /** 工作区相对于暂存区 */
  y: string
  /** 上一次提交里有没有这个路径（改了名的看的是原来那个路径） */
  inHead: boolean
}

export interface StatusOutput {
  /** 在哪个分支上。游离着是 null */
  branch: string | null
  /** 仓库里还一次提交都没有 */
  initial: boolean
  entries: StatusEntry[]
}

/** 读 git status --porcelain=v2 --branch -z 的输出 */
export function parseStatus(output: string): StatusOutput {
  const tokens = output.split('\0')
  const result: StatusOutput = { branch: null, initial: false, entries: [] }
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    if (token.startsWith('# branch.oid ')) {
      result.initial = token.slice('# branch.oid '.length) === '(initial)'
    } else if (token.startsWith('# branch.head ')) {
      const name = token.slice('# branch.head '.length)
      result.branch = name === '(detached)' ? null : name
    } else if (token.startsWith('? ')) {
      result.entries.push({
        path: token.slice(2),
        from: null,
        kind: 'untracked',
        x: '.',
        y: '?',
        inHead: false,
      })
    } else if (token.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path：路径里可以有空格，前面八栏没有
      const fields = token.split(' ')
      const path = fields.slice(8).join(' ')
      const xy = fields[1] ?? '..'
      if (!path) continue
      result.entries.push({
        path,
        from: null,
        kind: 'changed',
        x: xy.charAt(0),
        y: xy.charAt(1),
        inHead: fields[3] !== '000000',
      })
    } else if (token.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path，下一条记录是原来的路径
      const fields = token.split(' ')
      const path = fields.slice(9).join(' ')
      const xy = fields[1] ?? '..'
      const from = tokens[++at] ?? ''
      if (!path) continue
      result.entries.push({
        path,
        from: from || null,
        kind: 'changed',
        x: xy.charAt(0),
        y: xy.charAt(1),
        inHead: false,
      })
    } else if (token.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = token.split(' ')
      const path = fields.slice(10).join(' ')
      const xy = fields[1] ?? 'UU'
      if (!path) continue
      result.entries.push({
        path,
        from: null,
        kind: 'unmerged',
        x: xy.charAt(0),
        y: xy.charAt(1),
        inHead: true,
      })
    }
  }
  return result
}

/** git diff --raw --numstat -z 里的一个文件 */
export interface RawEntry {
  path: string
  from: string | null
  /** M、A、D、R、C、T、U 里的一个 */
  letter: string
  oldMode: string
  newMode: string
  added: number | null
  removed: number | null
  binary: boolean
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/

/**
 * 读 git diff --raw --numstat -z 的输出：先是每个文件一条状态（冒号开头），再是每个文件一条行数。
 * 两半按路径对起来
 */
export function parseRawNumstat(output: string): RawEntry[] {
  const tokens = output.split('\0')
  const entries: RawEntry[] = []
  const byPath = new Map<string, RawEntry>()
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    if (token.startsWith(':')) {
      // :旧权限 新权限 旧对象 新对象 状态，后面跟一个路径；改名和复制跟两个
      const fields = token.slice(1).split(' ')
      const letter = (fields[4] ?? 'M').charAt(0)
      const paired = letter === 'R' || letter === 'C'
      const first = tokens[++at] ?? ''
      const second = paired ? (tokens[++at] ?? '') : ''
      const path = paired ? second : first
      if (!path) continue
      const entry: RawEntry = {
        path,
        from: paired ? first : null,
        letter,
        oldMode: fields[0] ?? '000000',
        newMode: fields[1] ?? '000000',
        added: null,
        removed: null,
        binary: false,
      }
      entries.push(entry)
      byPath.set(path, entry)
      continue
    }
    const stat = NUMSTAT.exec(token)
    if (!stat) continue
    let path = stat[3] ?? ''
    if (path === '') {
      // 改名的那种：路径这一栏是空的，后面两条是旧名字、新名字
      at++
      path = tokens[++at] ?? ''
    }
    const entry = byPath.get(path)
    if (!entry) continue
    if (stat[1] === '-' || stat[2] === '-') {
      entry.binary = true
    } else {
      entry.added = Number(stat[1])
      entry.removed = Number(stat[2])
    }
  }
  return entries
}

/** 读 git grep -c -z 的输出：每条是“路径 NUL 行数 换行” */
export function parseGrepCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>()
  let at = 0
  while (at < output.length) {
    const nul = output.indexOf('\0', at)
    if (nul < 0) break
    const end = output.indexOf('\n', nul + 1)
    const count = Number(output.slice(nul + 1, end < 0 ? output.length : end))
    if (Number.isInteger(count)) counts.set(output.slice(at, nul), count)
    if (end < 0) break
    at = end + 1
  }
  return counts
}

const LETTERS: Record<string, DiffStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typeChanged',
  U: 'conflicted',
}

/** 没跟踪的文件，行数是另外数的。lines 里没有它：没去数（太多了），或者它不是文字 */
export interface UntrackedCounts {
  lines: Map<string, number>
  /** 去看过、确实不是文字的 */
  binary: Set<string>
  /** 去数过的那些。在这里面而 lines 里没有的是空文件 */
  counted: Set<string>
}

/** 仓库顶层算起的路径 → 相对于面板的根。prefix 是根在仓库里的位置（带末尾的斜杠，根就是顶层时是空串） */
export const stripPrefix = (path: string, prefix: string): string | null =>
  prefix === '' ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null

export interface SummaryInput {
  scope: DiffScope
  prefix: string
  status: StatusOutput
  /** 这个范围的 git diff --raw --numstat（路径已经相对于根） */
  raw: RawEntry[]
  untracked: UntrackedCounts
  /** 最多列多少个文件 */
  limit: number
}

const byPath = (a: DiffEntry, b: DiffEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/** 合成“变了哪些文件”的表 */
export function summarize(input: SummaryInput): { entries: DiffEntry[]; omitted: number } {
  const { scope, prefix, status, raw, untracked } = input
  /** 相对于根的路径 → status 里跟踪着的那一条（没跟踪的在下面另外列） */
  const flags = new Map<string, StatusEntry>()
  for (const entry of status.entries) {
    if (entry.kind === 'untracked') continue
    const path = stripPrefix(entry.path, prefix)
    if (path !== null) flags.set(path, entry)
  }
  const entries: DiffEntry[] = []
  for (const item of raw) {
    const flag = flags.get(item.path)
    const conflicted = flag?.kind === 'unmerged' || item.letter === 'U'
    // 改了名的：旧名字那一头在工作区里的删除还没暂存的话，也算没暂存的改动
    const fromFlag = item.from === null ? undefined : flags.get(item.from)
    entries.push({
      path: item.path,
      from: item.from,
      status: conflicted ? 'conflicted' : (LETTERS[item.letter] ?? 'modified'),
      added: item.added,
      removed: item.removed,
      binary: item.binary,
      mode:
        item.oldMode !== item.newMode && item.oldMode !== '000000' && item.newMode !== '000000'
          ? { from: item.oldMode, to: item.newMode }
          : null,
      staged: flag?.kind === 'changed' && flag.x !== '.',
      unstaged:
        (flag !== undefined && flag.kind !== 'unmerged' && flag.y !== '.') ||
        (fromFlag !== undefined && fromFlag.y !== '.'),
      dir: false,
    })
  }
  if (scope !== 'staged') {
    const listed = new Map(entries.map((entry) => [entry.path, entry]))
    for (const entry of status.entries) {
      if (entry.kind !== 'untracked') continue
      const path = stripPrefix(entry.path, prefix)
      if (path === null || path === '') continue
      const dir = path.endsWith('/')
      const name = dir ? path.slice(0, -1) : path
      // 行数：数到了的照数；去数过而没数到的是空文件；没去数的、不是文字的、整个目录都不写
      const lines = untracked.lines.get(name) ?? (untracked.counted.has(name) ? 0 : null)
      const binary = untracked.binary.has(name)
      const known = !dir && !binary && lines !== null
      // 暂存区里删了、工作区里又有一个同名的没跟踪的文件（git rm --cached 之后）：对着上一次提交看，
      // 它是一个文件整个换了内容，不是一删一加两条
      const same = listed.get(name)
      if (same) {
        same.unstaged = true
        if (dir) continue
        same.status = 'modified'
        same.added = known && same.removed !== null ? lines : null
        if (same.added === null) same.removed = null
        same.binary = same.binary || binary
        continue
      }
      entries.push({
        path: name,
        from: null,
        status: 'untracked',
        added: known ? lines : null,
        removed: known ? 0 : null,
        binary,
        mode: null,
        staged: false,
        unstaged: true,
        dir,
      })
    }
  }
  entries.sort(byPath)
  const omitted = Math.max(0, entries.length - input.limit)
  return { entries: omitted > 0 ? entries.slice(0, input.limit) : entries, omitted }
}

/**
 * 还原一个文件会做哪一类事，按 status 现在说的算：
 * remove：这个文件上一次提交里没有，还原就是删掉它（没跟踪的、新加的）；
 * restore：上一次提交里有，把内容（或者被删的文件）拿回来；
 * rename：改回原来的名字；conflict：合并冲突着，不在这里处理；clean：没有改动
 */
export type DiscardKind = 'remove' | 'restore' | 'rename' | 'conflict' | 'clean'

export function discardKindOf(entry: StatusEntry | undefined, scope: DiffScope): DiscardKind {
  if (!entry) return 'clean'
  if (entry.kind === 'unmerged') return 'conflict'
  if (entry.kind === 'untracked') return 'remove'
  if (scope === 'unstaged') return entry.y === '.' ? 'clean' : 'restore'
  // 复制出来的那一份上一次提交里没有，和新加的一样
  if (entry.from !== null) return entry.x === 'C' ? 'remove' : 'rename'
  return entry.inHead ? 'restore' : 'remove'
}

/** 界面上看到的状态对应还原时的哪一类。和 discardKindOf 对不上，就是文件在这期间又变了 */
export function expectedDiscard(status: DiffStatus, scope: DiffScope): DiscardKind {
  if (status === 'conflicted') return 'conflict'
  if (status === 'untracked') return 'remove'
  if (scope === 'unstaged') return 'restore'
  if (status === 'added' || status === 'copied') return 'remove'
  if (status === 'renamed') return 'rename'
  return 'restore'
}
