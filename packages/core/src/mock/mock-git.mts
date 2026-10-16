// 假的 git：模拟核心里“设备上的 git”。一个仓库是三棵树（上一次提交、暂存区、工作区），
// 差异面板用到的那几条命令（device/git.mts 里写的那些）照真的 git 的格式回答。
// 只认那几条命令的那几种写法，别的一律报错——它不是一个 git 的实现，只是让真的差异模块在模拟核心里有个对面。
// 和真的 git 对不对得上，test/mock-git.test.mts 里拿同一份内容两边各跑一遍来比。
import { hunksOf } from '../text/line-diff.mjs'

export interface FakeBlob {
  data: string | Uint8Array
  /** 可执行（100755）。不给就是普通文件（100644） */
  exec?: boolean
}

/** 相对于仓库顶层的路径 → 内容 */
export type FakeTree = Map<string, FakeBlob>

export interface FakeRepo {
  /** 仓库顶层在“设备”上的完整路径 */
  top: string
  branch: string
  /** 上一次提交。null：还一次提交都没有 */
  head: FakeTree | null
  index: FakeTree
  work: FakeTree
}

export interface FakeResult {
  exitCode: number
  stdout: string
  stderr: string
}

const ZERO = '0'.repeat(40)
const NO_MODE = '000000'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const modeOf = (blob: FakeBlob | undefined): string =>
  !blob ? NO_MODE : blob.exec ? '100755' : '100644'

const isBinary = (blob: FakeBlob | undefined): boolean =>
  blob !== undefined && (typeof blob.data !== 'string' || blob.data.includes('\0'))

/** 内容的“对象名”：不是真的 SHA-1，只要内容一样名字就一样、不一样就不一样 */
function nameOf(blob: FakeBlob | undefined): string {
  if (!blob) return ZERO
  const data = blob.data
  let out = ''
  for (let seed = 0; seed < 5; seed++) {
    let hash = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0
    const size = data.length
    for (let n = 0; n < size; n++) {
      const code = typeof data === 'string' ? data.charCodeAt(n) : (data[n] as number)
      hash = Math.imul(hash ^ code, 0x01000193) >>> 0
    }
    hash = Math.imul(hash ^ size, 0x01000193) >>> 0
    out += hash.toString(16).padStart(8, '0')
  }
  return out
}

const same = (a: FakeBlob | undefined, b: FakeBlob | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && sameData(a, b) && !a.exec === !b.exec)

function sameData(a: FakeBlob, b: FakeBlob): boolean {
  if (a.data === b.data) return true
  if (typeof a.data === 'string' || typeof b.data === 'string') return false
  if (a.data.length !== b.data.length) return false
  for (let n = 0; n < a.data.length; n++) if (a.data[n] !== b.data[n]) return false
  return true
}

interface Lines {
  lines: string[]
  /** 末尾没有换行 */
  noEol: boolean
}

function linesOf(blob: FakeBlob | undefined): Lines {
  const text = blob && typeof blob.data === 'string' ? blob.data : ''
  if (text === '') return { lines: [], noEol: false }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
    return { lines, noEol: false }
  }
  return { lines, noEol: true }
}

/** 拿来比的行：末尾没有换行的那一行和有换行的不算一样 */
const keyed = (side: Lines): string[] =>
  side.noEol
    ? side.lines.map((line, n) => (n === side.lines.length - 1 ? `${line}\0` : line))
    : side.lines

interface Change {
  /** 相对于仓库顶层 */
  path: string
  from: string | null
  letter: 'A' | 'D' | 'M' | 'R'
  before: FakeBlob | undefined
  after: FakeBlob | undefined
}

/** 两棵树之间变了哪些文件。内容一模一样的一删一加算改名 */
function changesBetween(before: FakeTree, after: FakeTree, prefix: string): Change[] {
  const changes: Change[] = []
  const paths = new Set([...before.keys(), ...after.keys()])
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const a = before.get(path)
    const b = after.get(path)
    if (same(a, b)) continue
    changes.push({
      path,
      from: null,
      letter: !a ? 'A' : !b ? 'D' : 'M',
      before: a,
      after: b,
    })
  }
  const gone = changes.filter((change) => change.letter === 'D')
  for (const added of changes.filter((change) => change.letter === 'A')) {
    const blob = added.after as FakeBlob
    // 空文件不拿来认改名（git 也不认）
    if (blob.data.length === 0) continue
    const match = gone.find(
      (change) => change.letter === 'D' && change.before && sameData(change.before, blob),
    )
    if (!match) continue
    added.letter = 'R'
    added.from = match.path
    added.before = match.before
    changes.splice(changes.indexOf(match), 1)
    gone.splice(gone.indexOf(match), 1)
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

/** 一个文件增删各多少行。不是文字的是 null */
function countsOf(change: Change): { added: number; removed: number } | null {
  if (isBinary(change.before) || isBinary(change.after)) return null
  if (change.letter === 'R') return { added: 0, removed: 0 }
  const a = linesOf(change.before)
  const b = linesOf(change.after)
  let added = 0
  let removed = 0
  for (const hunk of hunksOf(keyed(a), keyed(b), 0)) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

const range = (start: number, count: number): string =>
  count === 1 ? String(start) : `${start},${count}`

/** 一个文件的统一差异，照 git 的写法。path、from 是要写出来的路径（已经相对于当前目录） */
function patchOf(change: Change, path: string, from: string | null, context: number): string {
  const { before, after } = change
  const out: string[] = [`diff --git a/${from ?? path} b/${path}`]
  const oldMode = modeOf(before)
  const newMode = modeOf(after)
  if (change.letter === 'A') out.push(`new file mode ${newMode}`)
  else if (change.letter === 'D') out.push(`deleted file mode ${oldMode}`)
  else if (oldMode !== newMode) out.push(`old mode ${oldMode}`, `new mode ${newMode}`)
  if (change.letter === 'R') {
    out.push('similarity index 100%', `rename from ${from}`, `rename to ${path}`)
    return `${out.join('\n')}\n`
  }
  if (before && after && sameData(before, after)) return `${out.join('\n')}\n`
  const names = `${nameOf(before).slice(0, 7)}..${nameOf(after).slice(0, 7)}`
  out.push(
    change.letter === 'M' && oldMode === newMode ? `index ${names} ${newMode}` : `index ${names}`,
  )
  const oldName = before ? `a/${from ?? path}` : '/dev/null'
  const newName = after ? `b/${path}` : '/dev/null'
  if (isBinary(before) || isBinary(after)) {
    out.push(`Binary files ${oldName} and ${newName} differ`)
    return `${out.join('\n')}\n`
  }
  const a = linesOf(before)
  const b = linesOf(after)
  const hunks = hunksOf(keyed(a), keyed(b), context)
  if (hunks.length === 0) return `${out.join('\n')}\n`
  out.push(`--- ${oldName}`, `+++ ${newName}`)
  for (const hunk of hunks) {
    out.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    )
    let oldNo = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0)
    let newNo = hunk.newStart + (hunk.newLines === 0 ? 1 : 0)
    for (const line of hunk.lines) {
      const mark = line.charAt(0)
      // 拿来比的行末尾可能带着“没有换行”的记号：写出来时去掉，另起一行说明
      const bare = line.endsWith('\0')
      out.push(bare ? line.slice(0, -1) : line)
      if (mark !== '+') oldNo++
      if (mark !== '-') newNo++
      const lastOld = mark !== '+' && a.noEol && oldNo - 1 === a.lines.length
      const lastNew = mark !== '-' && b.noEol && newNo - 1 === b.lines.length
      if (lastOld || lastNew) out.push('\\ No newline at end of file')
    }
  }
  return `${out.join('\n')}\n`
}

/** 一个文件从一份内容变成另一份的统一差异，连同增删的行数。模拟的回合拿它填对话里“改了文件”的那一条 */
export function fakePatch(
  before: FakeBlob | undefined,
  after: FakeBlob | undefined,
  path: string,
): { text: string; added: number; removed: number } {
  const change: Change = {
    path,
    from: null,
    letter: !before ? 'A' : !after ? 'D' : 'M',
    before,
    after,
  }
  const counts = countsOf(change)
  return {
    text: patchOf(change, path, null, 3),
    added: counts?.added ?? 0,
    removed: counts?.removed ?? 0,
  }
}

/** 这个路径参数（相对于仓库顶层）指的是哪些路径：就是它自己，或者它是个目录时下面的全部 */
const under = (paths: Iterable<string>, spec: string): string[] => {
  if (spec === '' || spec === '.') return [...paths]
  const dir = `${spec}/`
  return [...paths].filter((path) => path === spec || path.startsWith(dir))
}

const fatal = (message: string): FakeResult => ({
  exitCode: 128,
  stdout: '',
  stderr: `fatal: ${message}\n`,
})

const done = (stdout = '', exitCode = 0): FakeResult => ({ exitCode, stdout, stderr: '' })

/** 参数里 “--” 前后各是什么 */
function split(args: readonly string[]): { flags: string[]; paths: string[] | null } {
  const at = args.indexOf('--')
  return at < 0
    ? { flags: [...args], paths: null }
    : { flags: args.slice(0, at), paths: args.slice(at + 1) }
}

function status(repo: FakeRepo, prefix: string): FakeResult {
  const head = repo.head ?? new Map<string, FakeBlob>()
  const records: string[] = [
    `# branch.oid ${repo.head ? nameOf({ data: repo.branch }) : '(initial)'}`,
    `# branch.head ${repo.branch}`,
  ]
  const renames = new Map<string, string>()
  const renamedFrom = new Set<string>()
  for (const change of changesBetween(head, repo.index, prefix)) {
    if (change.letter !== 'R' || change.from === null) continue
    renames.set(change.path, change.from)
    renamedFrom.add(change.from)
  }
  const paths = [...new Set([...head.keys(), ...repo.index.keys()])].sort()
  for (const path of paths) {
    if (!path.startsWith(prefix) || renamedFrom.has(path)) continue
    const inHead = head.get(path)
    const inIndex = repo.index.get(path)
    const inWork = repo.work.get(path)
    const from = renames.get(path)
    const x = from ? 'R' : same(inHead, inIndex) ? '.' : !inHead ? 'A' : !inIndex ? 'D' : 'M'
    const y = !inIndex ? '.' : !inWork ? 'D' : same(inIndex, inWork) ? '.' : 'M'
    if (x === '.' && y === '.') continue
    const original = from ? head.get(from) : inHead
    const fields = [
      `${x}${y}`,
      'N...',
      modeOf(original),
      modeOf(inIndex),
      modeOf(inIndex ? inWork : undefined),
      nameOf(original),
      nameOf(inIndex),
    ]
    if (from) records.push(`2 ${fields.join(' ')} R100 ${path}`, from)
    else records.push(`1 ${fields.join(' ')} ${path}`)
  }
  for (const path of [...repo.work.keys()].sort()) {
    if (path.startsWith(prefix) && !repo.index.has(path)) records.push(`? ${path}`)
  }
  return done(`${records.join('\0')}\0`)
}

function diff(repo: FakeRepo, prefix: string, args: readonly string[]): FakeResult {
  const { flags, paths } = split(args)
  if (flags.includes('--no-index')) return diffNoIndex(repo, prefix, flags, paths ?? [])
  const revs = flags.filter((flag) => !flag.startsWith('-'))
  const cached = flags.includes('--cached')
  const rev = revs[0]
  const base =
    rev === undefined || rev === 'HEAD'
      ? repo.head
      : rev === EMPTY_TREE
        ? new Map<string, FakeBlob>()
        : undefined
  if (base === undefined) return fatal(`bad revision '${rev}'`)
  if (rev === 'HEAD' && !repo.head) return fatal("bad revision 'HEAD'")
  // 不给两头：暂存区对工作区；--cached：上一次提交对暂存区；给了一头：它对工作区（没跟踪的不算）
  const before = cached || rev !== undefined ? (base ?? new Map<string, FakeBlob>()) : repo.index
  let after: FakeTree = cached ? repo.index : repo.work
  if (!cached) {
    after = new Map([...repo.work].filter(([path]) => repo.index.has(path)))
  }
  let changes = changesBetween(before, after, prefix)
  if (paths) {
    const wanted = new Set(
      paths.flatMap((spec) =>
        under(
          changes.map((c) => c.path),
          prefix + spec,
        ),
      ),
    )
    const sources = new Set(paths.map((spec) => prefix + spec))
    // 改名的只给了新名字、没给旧名字：照 git 的样子当成新加的
    changes = changes
      .filter((change) => wanted.has(change.path))
      .map((change) =>
        change.letter === 'R' && change.from !== null && !sources.has(change.from)
          ? { ...change, letter: 'A' as const, from: null, before: undefined }
          : change,
      )
  }
  const shown = (path: string): string => path.slice(prefix.length)
  if (flags.includes('--raw')) {
    const raw: string[] = []
    const stat: string[] = []
    for (const change of changes) {
      const head = `:${modeOf(change.before)} ${modeOf(change.after)} ${nameOf(change.before)} ${nameOf(change.after)}`
      const counts = countsOf(change)
      const numbers = counts ? `${counts.added}\t${counts.removed}` : '-\t-'
      if (change.letter === 'R' && change.from !== null) {
        raw.push(`${head} R100`, shown(change.from), shown(change.path))
        stat.push(`${numbers}\t`, shown(change.from), shown(change.path))
      } else {
        raw.push(`${head} ${change.letter}`, shown(change.path))
        stat.push(`${numbers}\t${shown(change.path)}`)
      }
    }
    const records = [...raw, ...stat]
    return done(records.length > 0 ? `${records.join('\0')}\0` : '')
  }
  const unified = flags.find((flag) => /^-U\d+$/.test(flag))
  const context = unified ? Number(unified.slice(2)) : 3
  return done(
    changes
      .map((change) =>
        patchOf(
          change,
          shown(change.path),
          change.from === null ? null : shown(change.from),
          context,
        ),
      )
      .join(''),
  )
}

/** git diff --no-index -- /dev/null 某个文件：拿它和“什么都没有”比 */
function diffNoIndex(
  repo: FakeRepo,
  prefix: string,
  flags: readonly string[],
  paths: readonly string[],
): FakeResult {
  const path = paths[1]
  if (paths[0] !== '/dev/null' || path === undefined) return fatal('usage: git diff --no-index')
  const blob = repo.work.get(prefix + path)
  if (!blob) {
    return { exitCode: 1, stdout: '', stderr: `error: Could not access '${path}'\n` }
  }
  const change: Change = { path, from: null, letter: 'A', before: undefined, after: blob }
  if (flags.includes('--numstat')) {
    const counts = countsOf(change)
    return done(`${counts ? `${counts.added}\t0` : '-\t-'}\t${path}\n`, 1)
  }
  return done(patchOf(change, path, null, 3), 1)
}

/** git grep -c -z -e '' -- 路径…：每个是文字的、不空的文件有多少行 */
function grep(repo: FakeRepo, prefix: string, args: readonly string[]): FakeResult {
  const out: string[] = []
  for (const path of split(args).paths ?? []) {
    const blob = repo.work.get(prefix + path)
    if (!blob || isBinary(blob)) continue
    const count = linesOf(blob).lines.length
    if (count > 0) out.push(`${path}\0${count}\n`)
  }
  return done(out.join(''), out.length > 0 ? 0 : 1)
}

/** 改东西的那几条。每条只认 device/git.mts 里用到的那一种写法 */
function write(
  repo: FakeRepo,
  prefix: string,
  command: string,
  args: readonly string[],
): FakeResult {
  const { flags, paths } = split(args)
  const specs = (paths ?? []).map((path) => prefix + path)
  const head = repo.head ?? new Map<string, FakeBlob>()
  const everything = new Set([...head.keys(), ...repo.index.keys(), ...repo.work.keys()])
  let touched = 0
  for (const spec of specs) {
    for (const path of under(everything, spec)) {
      const inHead = head.get(path)
      const inIndex = repo.index.get(path)
      const inWork = repo.work.get(path)
      if (command === 'add') {
        if (inWork) repo.index.set(path, inWork)
        else repo.index.delete(path)
      } else if (command === 'reset') {
        if (inHead) repo.index.set(path, inHead)
        else repo.index.delete(path)
      } else if (command === 'checkout' && flags.includes('HEAD')) {
        if (!inHead) continue
        repo.index.set(path, inHead)
        repo.work.set(path, inHead)
      } else if (command === 'checkout') {
        if (!inIndex) continue
        repo.work.set(path, inIndex)
      } else if (command === 'rm') {
        if (!inIndex) continue
        repo.index.delete(path)
        repo.work.delete(path)
      } else if (command === 'clean') {
        if (inIndex || !inWork) continue
        repo.work.delete(path)
      }
      touched++
    }
  }
  if (touched === 0 && (command === 'checkout' || command === 'rm')) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `error: pathspec '${paths?.[0] ?? ''}' did not match any file(s) known to git\n`,
    }
  }
  return done()
}

const WRITES = new Set(['add', 'reset', 'checkout', 'rm', 'clean'])

/** 这条命令会不会改东西 */
export function fakeGitWrites(argv: readonly string[]): boolean {
  return WRITES.has(subcommand(argv).name)
}

/** 去掉开头的 git 和它自己的选项，剩下子命令和子命令的参数 */
function subcommand(argv: readonly string[]): { name: string; args: string[] } {
  let at = argv[0] === 'git' ? 1 : 0
  while (at < argv.length) {
    const arg = argv[at] as string
    if (arg === '-c') at += 2
    else if (arg.startsWith('-')) at++
    else break
  }
  return { name: argv[at] ?? '', args: argv.slice(at + 1) }
}

/**
 * 在 cwd 这个目录里跑一条 git 命令。repo 是包着这个目录的那个仓库，没有就是 null
 */
export function fakeGit(repo: FakeRepo | null, cwd: string, argv: readonly string[]): FakeResult {
  const { name, args } = subcommand(argv)
  if (name === 'hash-object') return done(`${EMPTY_TREE}\n`)
  if (!repo) return fatal('not a git repository (or any of the parent directories): .git')
  const prefix = cwd === repo.top ? '' : `${cwd.slice(repo.top.length + 1)}/`
  if (name === 'rev-parse') return done(`${repo.top}\n${repo.top}/.git\n${prefix}\n`)
  if (name === 'status') return status(repo, prefix)
  if (name === 'diff') return diff(repo, prefix, args)
  if (name === 'grep') return grep(repo, prefix, args)
  if (WRITES.has(name)) return write(repo, prefix, name, args)
  return { exitCode: 1, stdout: '', stderr: `git: '${name}' is not a git command.\n` }
}
