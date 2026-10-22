// 一台设备上的差异：某个根（工作区的根，或者会话的工作目录）里现在有哪些没提交的改动、各改了什么，
// 以及文件级的暂存、取消暂存、还原。差异面板订阅概况（哪些文件、增删多少行），内容按需来取。
//
// 数据以工作目录的 git 状态为准，在设备上跑 git 取（exec.mts、git.mts），哪种对面都是同一条路。
// 看不了 git 的时候（不是仓库、没装 git、对面不会起进程），harness 给过本回合差异的就用它（turn/diff/updated），
// 那是唯一的来源；也没有就照实说。
//
// 什么时候重新取：有人开始看、回合结束、这边自己暂存或还原之后、手动刷新、对面报文件变了（fs/watch，
// 只盯 git 的元数据目录和根这一层，盯不到更深的）。没人订阅的根不取数，这期间有过动静只记一笔，下次有人看再取。
// 不定时轮询。
import type {
  ClientRequestMethod,
  ClientRequests,
  ServerNotifications,
} from '../../../protocol/src/index.mjs'
import {
  type AbortSignalLike,
  ChannelError,
  type ChannelErrorShape,
  type Clock,
} from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcAbortError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  DiffBundle,
  DiffEntry,
  DiffRequests,
  DiffScope,
  DiffStatus,
  DiffView,
  FileDiff,
} from '../model-diff.mjs'
import { DIFF_SCOPES } from '../model-diff.mjs'
import { phrase } from '../phrase.mjs'
import { languageOf, unreadableGroup } from '../projection/files.mjs'
import {
  discardKindOf,
  expectedDiscard,
  type StatusOutput,
  stripPrefix,
  summarize,
  type UntrackedCounts,
} from '../projection/git-output.mjs'
import { type PatchFile, parsePatch } from '../text/patch.mjs'
import {
  insideRoot,
  isAbsolutePath,
  isNetworkPath,
  joinPath,
  normalizePath,
  pathTwin,
  relativeTo,
  withinRoot,
} from '../text/paths.mjs'
import { createExec } from './exec.mjs'
import { lacksMethod } from './faults.mjs'
import { createGit, GitFailure, type GitProbe, gitFailure } from './git.mjs'

export interface DiffsHost {
  clock: Clock
  online(): boolean
  /** 对面的系统（macos、linux、windows），还不知道是 null：路径的另一种写法按它认（text/paths.mts 的 pathTwin） */
  platform(): string | null
  /** 这个目录是不是这台设备上认得的根：某个工作区的根，或者某个会话的工作目录。给的是理过的路径 */
  knownRoot(root: string): boolean
  /** 这个会话所属的 harness 发不发本回合的差异：它声明了的照声明；没有声明是 null（来了就用） */
  turnDiffDeclared(sessionId: string): boolean | null
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
  random?(): number
}

export interface Diffs {
  /** 订阅一个根的差异概况。先给一份快照，之后每次变了给一条 diff.set */
  open(root: string, scope: DiffScope, sessionId: string | null, sink: HostSink): () => void
  /** 全部文件的差异，一次取回来。合起来太大的话 truncated 为真、不带内容 */
  files(
    root: string,
    scope: DiffScope,
    sessionId: string | null,
    signal?: AbortSignalLike,
  ): Promise<DiffBundle>
  /** 一个文件的差异。full：带上整个文件当上下文 */
  file(
    root: string,
    scope: DiffScope,
    sessionId: string | null,
    path: string,
    full: boolean,
    signal?: AbortSignalLike,
  ): Promise<FileDiff>
  refresh(root: string): Promise<void>
  stage(root: string, paths: readonly string[]): Promise<void>
  unstage(root: string, paths: readonly string[]): Promise<void>
  /**
   * 还原一个文件：改动丢掉，找不回来。expect 是界面上确认时看到的状态；
   * 文件在这期间变成了另一种情形（比如从“改了”变成了“没跟踪”）就不动它，以 conflict 结束
   */
  discard(root: string, scope: DiffScope, path: string, expect: DiffStatus): Promise<void>
  /** 一个回合结束了：有人看着的根重新取 */
  turnEnded(sessionId: string): void
  /** harness 给的本回合差异（整份） */
  turnDiff(sessionId: string, turnId: string, diff: string): void
  /** 是这里的通知（跑的命令结束了、盯着的路径变了）就处理并返回 true */
  notification(method: string, params: unknown): boolean
  requests(): DiffRequests
  /** 连上并认出对面是谁了：上一次连接里记的不算数，有人看着的根重新取 */
  resync(): void
  offline(): void
}

/** 没人看了之后，这个根的数据再留这么久：在同一个工作区的几个会话之间切，不用每次从头取 */
export const DIFF_LINGER_MS = 30_000
/** 对面报文件变了之后等这么久再取：一连串的变化合成一次 */
export const DIFF_WATCH_DELAY_MS = 400
/** 因为“文件变了”而取，两次之间至少隔这么久 */
export const DIFF_WATCH_GAP_MS = 1500
/** 没人看了又回来，离上一次取过了这么久就重新取 */
const REOPEN_FRESH_MS = 3000
/** 自己刚暂存、还原过：这么久之内对面报的变化就是自己弄出来的，不用再取一遍 */
const OWN_QUIET_MS = 800
/** 最多列这么多个文件，再多的只报个数 */
export const DIFF_LIST_MAX = 3000
/** 最多给这么多个没跟踪的文件数行数 */
export const DIFF_UNTRACKED_COUNTED = 400
/** 数不出行数的没跟踪文件（空的，或者不是文字的），最多去问这么多个到底是哪一种 */
const BINARY_PROBES = 24
/** 一次取全部文件的差异，文件数超过这个就不取 */
export const DIFF_BUNDLE_FILES = 300
/** 本回合差异最多留这么多个字，再大的不留内容 */
const TURN_DIFF_MAX = 4 * 1024 * 1024
/** 最多留这么多个会话的本回合差异 */
const TURN_KEEP = 24

interface Sub {
  scope: DiffScope
  sessionId: string | null
  sink: HostSink
  /** 上一次给它的那份，写成字符串：一样的不重发 */
  sent: string
}

interface Summary {
  entries: DiffEntry[]
  omitted: number
}

interface Room {
  root: string
  subs: Set<Sub>
  /** null：还没认过这个目录 */
  probe: GitProbe | null
  /** 这条连接上认过没有。重连之后要重新认一遍，但认之前先照旧显示 */
  verified: boolean
  /** 没人订阅、但有命令来要过的范围：取概况的时候也算上 */
  extra: Set<DiffScope>
  /** 正在向对面登记监视 */
  arming: boolean
  status: StatusOutput | null
  /** 还没有提交的仓库里当“上一次提交”用的空树 */
  emptyTree: string | null
  summaries: Map<DiffScope, Summary>
  error: ChannelErrorShape | null
  version: number
  refreshing: boolean
  running: Promise<void> | null
  /** 正在取的时候又有人要取：这一趟完了接着再来一趟 */
  again: boolean
  /** 没人看的时候有过动静：下次有人看要重新取 */
  stale: boolean
  watches: string[]
  quietUntil: number
  lastLoadedAt: number
  stopLinger: (() => void) | null
  stopDelay: (() => void) | null
}

interface TurnRecord {
  turnId: string
  version: number
  /** null：太大了，没留内容 */
  files: PatchFile[] | null
}

const STATUS_OF: Record<PatchFile['change'], DiffStatus> = {
  modify: 'modified',
  add: 'added',
  delete: 'deleted',
  rename: 'renamed',
  copy: 'copied',
}

/** 读出来的一个文件 → 界面看到的样子 */
function fileOf(path: string, from: string | null, parsed: PatchFile, full: boolean): FileDiff {
  return {
    path,
    from,
    kind: parsed.binary ? 'binary' : parsed.hunks.length === 0 ? 'empty' : 'text',
    hunks: parsed.binary ? [] : parsed.hunks,
    full,
    language: languageOf(path),
    noEolOld: parsed.noEolOld,
    noEolNew: parsed.noEolNew,
    added: parsed.added,
    removed: parsed.removed,
  }
}

/** 没有内容可给的那几种 */
const placeholder = (
  entry: { path: string; from: string | null },
  kind: FileDiff['kind'],
): FileDiff => ({
  path: entry.path,
  from: entry.from,
  kind,
  hunks: [],
  full: false,
  language: languageOf(entry.path),
  noEolOld: false,
  noEolNew: false,
  added: 0,
  removed: 0,
})

/**
 * 暂存区里删了、工作区里又有同名的没跟踪文件：git 不拿这两头直接比，这里把“删掉的那些行”和“新文件的那些行”
 * 接成一段，当成整个换了内容
 */
function swapped(gone: FileDiff, fresh: FileDiff): FileDiff {
  for (const kind of ['binary', 'tooLarge'] as const) {
    if (gone.kind === kind || fresh.kind === kind) return { ...fresh, kind, hunks: [] }
  }
  const minus = gone.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith('-')))
  const plus = fresh.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith('+')))
  if (minus.length === 0 && plus.length === 0) return { ...fresh, kind: 'empty', hunks: [] }
  return {
    ...fresh,
    kind: 'text',
    full: true,
    hunks: [
      {
        oldStart: minus.length > 0 ? 1 : 0,
        oldLines: minus.length,
        newStart: plus.length > 0 ? 1 : 0,
        newLines: plus.length,
        section: '',
        lines: [...minus, ...plus],
      },
    ],
    noEolOld: gone.noEolOld,
    added: plus.length,
    removed: minus.length,
  }
}

export function createDiffs(host: DiffsHost): Diffs {
  const { clock } = host
  const random = host.random ?? Math.random
  const tag = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  const asked: DiffRequests = { spawns: 0, refreshes: 0, byKind: {} }
  const exec = createExec({
    clock,
    request: (method, params, options) => host.request(method, params, options),
    random,
  })
  const git = createGit({
    exec,
    request: (method, params, options) => host.request(method, params, options),
    tally(kind) {
      asked.spawns++
      asked.byKind[kind] = (asked.byKind[kind] ?? 0) + 1
    },
  })
  const rooms = new Map<string, Room>()
  const watched = new Map<string, Room>()
  const turns = new Map<string, TurnRecord>()
  /** 每次连上换一个：途中断了重连，回来的结果按它作废 */
  let epoch = 0
  let stamp = 0
  let watchSeq = 0
  /** 对面说过不认识 fs/watch：到下次重连之前不再去问 */
  let lacksWatch = false

  // ---------- 认根、认路径 ----------

  const locate = (root: string): string => {
    if (typeof root !== 'string' || !root) {
      throw new ChannelError('rejected', '没有给根目录', phrase('files.unknownRoot'))
    }
    if (isNetworkPath(root)) {
      throw new ChannelError('unsupported', '网络共享上的目录还不支持', phrase('files.network'))
    }
    const base = normalizePath(root)
    if (!isAbsolutePath(base) || !host.knownRoot(base)) {
      throw new ChannelError('rejected', `不认识这个根目录：${root}`, phrase('files.unknownRoot'))
    }
    return base
  }

  /** 核对一个相对于根的路径：得是理过的相对路径，落在根里面，不是根自己 */
  const checkPath = (root: string, path: string): string => {
    const bad =
      typeof path !== 'string' ||
      path === '' ||
      path.includes('\0') ||
      isAbsolutePath(path) ||
      normalizePath(path) !== path ||
      path === '..' ||
      path.startsWith('../')
    if (!bad) {
      const full = joinPath(root, path)
      if (full !== root && insideRoot(root, full)) return path
    }
    throw new ChannelError(
      'rejected',
      `路径不在工作区之内：${String(path)}`,
      phrase('files.outside'),
    )
  }

  /** 这个路径是不是“暂存区里删了、工作区里又有同名的没跟踪文件” */
  const replaced = (room: Room, path: string): boolean => {
    if (!room.probe?.ok || !room.status) return false
    const { prefix } = room.probe.facts
    return room.status.entries.some(
      (entry) => entry.kind === 'untracked' && stripPrefix(entry.path, prefix) === path,
    )
  }

  const mustBeOnline = () => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
  }

  // ---------- 本回合差异 ----------

  /** 这个会话能不能拿本回合差异当来源：声明了不发的不能；声明了发的、没有声明的都算能 */
  const turnCapable = (sessionId: string | null): boolean =>
    sessionId !== null && host.turnDiffDeclared(sessionId) !== false

  const turnOf = (sessionId: string | null): TurnRecord | null =>
    sessionId !== null && turnCapable(sessionId) ? (turns.get(sessionId) ?? null) : null

  /**
   * 本回合差异里的路径：给的是完整路径而且在根里面的，换成相对于根的；别的原样。
   * harness 给的可能是根的另一种写法（macOS 上 Claude Code 给的是 /private/var/…，根是 /var/…），也算在里面
   */
  const turnPath = (root: string, path: string): string => {
    if (!isAbsolutePath(path)) return path
    const inside = withinRoot(root, normalizePath(path), pathTwin(host.platform()))
    return inside !== null && inside !== root ? relativeTo(root, inside) : path
  }

  /** 本回合差异里的文件，按路径排好（概况和内容都按这个顺序给） */
  const turnFiles = (root: string, record: TurnRecord | null) =>
    (record?.files ?? [])
      .map((file) => ({
        file,
        path: turnPath(root, file.path),
        from: file.from === null ? null : turnPath(root, file.from),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const turnEntries = (root: string, record: TurnRecord): DiffEntry[] =>
    turnFiles(root, record).map(({ file, path, from }) => ({
      path,
      from,
      status: STATUS_OF[file.change],
      added: file.binary ? null : file.added,
      removed: file.binary ? null : file.removed,
      binary: file.binary,
      mode: file.mode,
      staged: false,
      unstaged: false,
      dir: false,
    }))

  // ---------- 给界面的样子 ----------

  const viewOf = (room: Room, sub: Sub): DiffView => {
    const base: DiffView = {
      phase: 'loading',
      source: 'git',
      why: null,
      error: null,
      refreshing: room.refreshing,
      version: room.version,
      branch: null,
      entries: [],
      omitted: 0,
      watching: room.watches.length > 0,
      writable: false,
    }
    if (room.error) return { ...base, phase: 'failed', error: room.error }
    if (!room.probe) return base
    if (!room.probe.ok) {
      const why = room.probe.why
      const record = turnOf(sub.sessionId)
      if (record) {
        return {
          ...base,
          phase: 'ready',
          source: 'turn',
          why,
          version: record.version,
          entries: turnEntries(room.root, record),
        }
      }
      // 这个 harness 会发本回合差异、只是还没发过的，来源也标成 turn：界面据此说“回合里有改动时会显示在这里”
      return { ...base, phase: 'absent', why, source: turnCapable(sub.sessionId) ? 'turn' : 'git' }
    }
    const summary = room.summaries.get(sub.scope)
    if (!summary) return base
    return {
      ...base,
      phase: 'ready',
      branch: room.status?.branch ?? null,
      entries: summary.entries,
      omitted: summary.omitted,
      writable: true,
    }
  }

  const publish = (room: Room) => {
    for (const sub of room.subs) {
      const view = viewOf(room, sub)
      const text = JSON.stringify(view)
      if (text === sub.sent) continue
      sub.sent = text
      sub.sink.delta([{ op: 'diff.set', view }])
    }
  }

  // ---------- 盯着文件变没变 ----------

  const unwatch = (room: Room) => {
    for (const watchId of room.watches) {
      watched.delete(watchId)
      if (host.online()) host.request('fs/unwatch', { watchId }).catch(() => {})
    }
    room.watches = []
  }

  /** 盯 git 的元数据目录（暂存、提交、换分支都会动它）和根这一层。对面不会就记住，不再去问 */
  const ensureWatch = async (room: Room, mine: number) => {
    if (lacksWatch || room.arming || room.watches.length > 0 || room.subs.size === 0) return
    if (!room.probe?.ok) return
    room.arming = true
    try {
      await arm(room, mine, [room.probe.facts.gitDir, room.root])
    } finally {
      room.arming = false
    }
    // 盯上了没有，界面要知道（“重新取”上的说明）：对面的应答比概况晚到，到了再报一次
    if (mine === epoch && rooms.get(room.root) === room) publish(room)
  }

  const arm = async (room: Room, mine: number, paths: string[]) => {
    for (const path of paths) {
      const watchId = `litch-diff-${tag}-${++watchSeq}`
      try {
        await host.request('fs/watch', { watchId, path })
      } catch (error) {
        if (lacksMethod(error)) lacksWatch = true
        else host.log(`盯不住 ${path}：${String(error)}`)
        break
      }
      if (mine !== epoch || !rooms.has(room.root) || room.subs.size === 0) {
        // 等应答的这一会儿里连接换了、或者没人看了：这一个不要了
        if (mine === epoch) host.request('fs/unwatch', { watchId }).catch(() => {})
        return
      }
      room.watches.push(watchId)
      watched.set(watchId, room)
    }
  }

  const changed = (room: Room) => {
    if (room.subs.size === 0) {
      room.stale = true
      return
    }
    const now = clock.now()
    if (now < room.quietUntil || room.stopDelay) return
    const wait = Math.max(DIFF_WATCH_DELAY_MS, room.lastLoadedAt + DIFF_WATCH_GAP_MS - now)
    room.stopDelay = clock.setTimer(() => {
      room.stopDelay = null
      if (room.subs.size > 0) void refresh(room)
      else room.stale = true
    }, wait)
  }

  // ---------- 取概况 ----------

  /** 没跟踪的文件各有多少行。只数前面一部分：太多的话后面的不数，界面上不写行数 */
  const countUntracked = async (
    room: Room,
    status: StatusOutput,
    prefix: string,
  ): Promise<UntrackedCounts> => {
    const files: string[] = []
    for (const entry of status.entries) {
      if (entry.kind !== 'untracked') continue
      const path = stripPrefix(entry.path, prefix)
      if (path && !path.endsWith('/')) files.push(path)
    }
    files.sort()
    const counted = files.slice(0, DIFF_UNTRACKED_COUNTED)
    const lines = counted.length > 0 ? await git.countLines(room.root, counted) : new Map()
    const unknown = counted.filter((path) => !lines.has(path))
    const binary = new Set<string>()
    await Promise.all(
      unknown.slice(0, BINARY_PROBES).map(async (path) => {
        if (await git.untrackedIsBinary(room.root, path)) binary.add(path)
      }),
    )
    // 没去问的：看扩展名猜。猜错了也只是概况里少一个“二进制”的记号，点开时以 git 说的为准
    for (const path of unknown.slice(BINARY_PROBES)) {
      if (unreadableGroup(path)) binary.add(path)
    }
    return { lines, binary, counted: new Set(counted) }
  }

  const revOf = (scope: DiffScope, base: string): string[] =>
    scope === 'all' ? [base] : scope === 'staged' ? ['--cached'] : []

  const baseOf = async (room: Room, status: StatusOutput): Promise<string> => {
    if (!status.initial) return 'HEAD'
    room.emptyTree ??= await git.emptyTree(room.root)
    return room.emptyTree
  }

  const load = async (room: Room, mine: number): Promise<void> => {
    // 上一次认定看不了 git 的也重新认一遍：可能刚 git init 过、刚装上 git
    const probe = room.probe?.ok && room.verified ? room.probe : await git.probe(room.root)
    if (mine !== epoch) return
    room.verified = true
    if (!probe.ok) {
      room.probe = probe
      room.status = null
      room.summaries.clear()
      return
    }
    let status: StatusOutput
    try {
      status = await git.status(room.root)
    } catch (error) {
      // 仓库在这期间没了（.git 被删了）：下一趟从头认
      if (error instanceof GitFailure && /not a git repository/i.test(error.stderr)) {
        room.probe = null
        room.again = true
        return
      }
      throw error
    }
    const scopes = DIFF_SCOPES.filter(
      (scope) => room.extra.has(scope) || [...room.subs].some((sub) => sub.scope === scope),
    )
    const { prefix } = probe.facts
    const base = scopes.includes('all') ? await baseOf(room, status) : 'HEAD'
    const needUntracked = scopes.some((scope) => scope !== 'staged')
    const [untracked, ...raws] = await Promise.all([
      needUntracked
        ? countUntracked(room, status, prefix)
        : {
            lines: new Map<string, number>(),
            binary: new Set<string>(),
            counted: new Set<string>(),
          },
      ...scopes.map((scope) => git.changed(room.root, revOf(scope, base))),
    ])
    if (mine !== epoch) return
    const summaries = new Map<DiffScope, Summary>()
    scopes.forEach((scope, at) => {
      const raw = raws[at]
      if (!raw) return
      summaries.set(
        scope,
        summarize({ scope, prefix, status, raw: raw.entries, untracked, limit: DIFF_LIST_MAX }),
      )
    })
    room.probe = probe
    room.status = status
    // 没人看的范围不留：下次有人看再取，免得拿出一份旧的
    room.summaries = summaries
  }

  const refresh = (room: Room): Promise<void> => {
    if (room.running) {
      room.again = true
      return room.running
    }
    const mine = epoch
    const work = (async () => {
      do {
        room.again = false
        room.stale = false
        room.refreshing = true
        publish(room)
        asked.refreshes++
        try {
          await load(room, mine)
          if (mine !== epoch) return
          room.error = null
          room.version = ++stamp
        } catch (error) {
          if (mine !== epoch) return
          if (error instanceof RpcAbortError && error.reason === 'closed') return
          room.error = gitFailure(error, host.fail).toShape()
        }
        room.lastLoadedAt = clock.now()
        if (mine === epoch) void ensureWatch(room, mine)
      } while (room.again && mine === epoch && host.online())
    })().finally(() => {
      // 途中换了连接的话，这一趟已经被新的一趟顶掉了：不动它的状态
      if (room.running !== work) return
      room.running = null
      room.refreshing = false
      publish(room)
    })
    room.running = work
    return work
  }

  const roomOf = (root: string): Room => {
    const known = rooms.get(root)
    if (known) return known
    const room: Room = {
      root,
      subs: new Set(),
      probe: null,
      verified: false,
      extra: new Set(),
      arming: false,
      status: null,
      emptyTree: null,
      summaries: new Map(),
      error: null,
      version: 0,
      refreshing: false,
      running: null,
      again: false,
      stale: true,
      watches: [],
      quietUntil: 0,
      lastLoadedAt: 0,
      stopLinger: null,
      stopDelay: null,
    }
    rooms.set(root, room)
    return room
  }

  /** 没人看了：过一会儿还没人回来，就不盯了、数据也不留了 */
  const linger = (room: Room) => {
    room.stopLinger?.()
    room.stopLinger = clock.setTimer(() => {
      room.stopLinger = null
      if (room.subs.size > 0) return
      room.stopDelay?.()
      unwatch(room)
      rooms.delete(room.root)
    }, DIFF_LINGER_MS)
  }

  /** 给命令用的：这个根的概况（scope 给了的话，连同那个范围的）要是现成的；没有就先取一遍 */
  const ready = async (root: string, scope: DiffScope | null): Promise<Room> => {
    const room = roomOf(root)
    if (room.subs.size === 0 && !room.stopLinger) linger(room)
    const lacks = () => scope !== null && room.probe?.ok === true && !room.summaries.has(scope)
    if (lacks() && scope !== null && ![...room.subs].some((sub) => sub.scope === scope)) {
      room.extra.add(scope)
    }
    // 正取着的等它取完，不另要一趟：界面每见到一版新的概况就来要一次内容，
    // 要是每来一次都让正在取的那一趟“完了再来一遍”，就成了没完没了地重取
    if (room.running) await room.running
    if (!room.probe || lacks()) {
      mustBeOnline()
      await refresh(room)
    }
    if (room.error) throw new ChannelError(room.error.code, room.error.message, room.error.text)
    return room
  }

  const mustGit = async (root: string) => {
    const room = await ready(root, null)
    if (!room.probe?.ok) {
      throw new ChannelError('rejected', '这里不是 git 仓库', phrase('diff.notWritable'))
    }
    return { room, facts: room.probe.facts }
  }

  /** 自己刚动过：马上重新取一遍，这一小会儿里对面报的变化不用再理 */
  const afterWrite = async (room: Room) => {
    room.quietUntil = clock.now() + OWN_QUIET_MS
    await refresh(room)
    room.quietUntil = clock.now() + OWN_QUIET_MS
    if (room.error) throw new ChannelError(room.error.code, room.error.message, room.error.text)
  }

  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw gitFailure(error, host.fail)
    }
  }

  /** 一个没跟踪的文件的差异 */
  const untrackedFile = async (
    room: Room,
    entry: DiffEntry,
    signal: AbortSignalLike | undefined,
  ): Promise<FileDiff> => {
    if (entry.dir) return placeholder(entry, 'directory')
    const result = await git.patchUntracked(room.root, entry.path, signal)
    if (result.capped) return placeholder(entry, 'tooLarge')
    const parsed = parsePatch(result.stdout)[0]
    if (!parsed) return placeholder(entry, result.exitCode === 0 ? 'empty' : 'missing')
    // 新文件的差异本来就是整个文件
    return fileOf(entry.path, null, parsed, true)
  }

  return {
    open(root, scope, sessionId, sink) {
      const at = locate(root)
      if (!DIFF_SCOPES.includes(scope)) throw new ChannelError('rejected', '无效的比较范围')
      const room = roomOf(at)
      room.stopLinger?.()
      room.stopLinger = null
      const sub: Sub = { scope, sessionId: sessionId ?? null, sink, sent: '' }
      // 隔了一阵没人看又回来的：这期间更深的目录里有什么变化是盯不到的，重新取一遍
      const back = room.subs.size === 0 && clock.now() - room.lastLoadedAt > REOPEN_FRESH_MS
      room.subs.add(sub)
      const view = viewOf(room, sub)
      sub.sent = JSON.stringify(view)
      sink.snapshot(view)
      // 开始看：没取过、放旧了、或者这个范围还没有，就去取
      const missing = room.probe?.ok === true && !room.summaries.has(scope)
      if (host.online() && (back || room.stale || !room.probe || missing || room.error)) {
        void refresh(room)
      }
      return () => {
        room.subs.delete(sub)
        if (room.subs.size > 0) return
        // 盯不住变化的，没人看的这一会儿里发生了什么不知道：回来时重新取
        if (room.watches.length === 0) room.stale = true
        linger(room)
      }
    },

    async files(root, scope, sessionId, signal) {
      const at = locate(root)
      const room = await ready(at, scope)
      return guarded(async () => {
        if (!room.probe?.ok) {
          const record = turnOf(sessionId)
          const files = turnFiles(at, record).map(({ file, path, from }) =>
            fileOf(path, from, file, false),
          )
          return { version: record?.version ?? room.version, files, truncated: false }
        }
        const summary = room.summaries.get(scope)
        const version = room.version
        if (!summary || summary.entries.length > DIFF_BUNDLE_FILES || summary.omitted > 0) {
          return { version, files: [], truncated: true }
        }
        if (!room.status) return { version, files: [], truncated: true }
        const base = scope === 'all' ? await baseOf(room, room.status) : 'HEAD'
        const tracked = summary.entries.some((entry) => entry.status !== 'untracked')
          ? await git.patchAll(at, revOf(scope, base), signal)
          : null
        if (tracked?.capped) return { version, files: [], truncated: true }
        const parsed = new Map<string, PatchFile>()
        for (const file of parsePatch(tracked?.stdout ?? '')) parsed.set(file.path, file)
        const files = await Promise.all(
          summary.entries.map(async (entry) => {
            if (entry.status === 'untracked') return untrackedFile(room, entry, signal)
            const file = parsed.get(entry.path)
            const tracked = file
              ? fileOf(entry.path, entry.from, file, false)
              : placeholder(entry, entry.binary ? 'binary' : 'missing')
            return scope === 'all' && replaced(room, entry.path)
              ? swapped(tracked, await untrackedFile(room, entry, signal))
              : tracked
          }),
        )
        return { version, files, truncated: false }
      })
    },

    async file(root, scope, sessionId, path, full, signal) {
      const at = locate(root)
      const room = await ready(at, scope)
      return guarded(async () => {
        if (!room.probe?.ok) {
          const found = turnFiles(at, turnOf(sessionId)).find((item) => item.path === path)
          return found
            ? fileOf(path, found.from, found.file, false)
            : placeholder({ path, from: null }, 'missing')
        }
        const wanted = checkPath(at, path)
        const entry = room.summaries.get(scope)?.entries.find((item) => item.path === wanted)
        if (!entry || !room.status) return placeholder({ path: wanted, from: null }, 'missing')
        if (entry.status === 'untracked') return untrackedFile(room, entry, signal)
        const base = scope === 'all' ? await baseOf(room, room.status) : 'HEAD'
        // 改了名的把旧名字一起给：只给新名字的话 git 认不出这是改名，会当成新加的
        const paths = entry.from === null ? [wanted] : [wanted, checkPath(at, entry.from)]
        const result = await git.patch(at, revOf(scope, base), paths, full, signal)
        if (result.capped) return placeholder(entry, 'tooLarge')
        const files = parsePatch(result.stdout)
        const found = files.find((file) => file.path === wanted) ?? files[0]
        if (!found) return placeholder(entry, 'missing')
        const tracked = fileOf(wanted, entry.from, found, full)
        return scope === 'all' && replaced(room, wanted)
          ? swapped(tracked, await untrackedFile(room, entry, signal))
          : tracked
      })
    },

    async refresh(root) {
      const room = roomOf(locate(root))
      if (room.subs.size === 0 && !room.stopLinger) linger(room)
      mustBeOnline()
      await refresh(room)
    },

    async stage(root, paths) {
      const at = locate(root)
      mustBeOnline()
      const { room } = await mustGit(at)
      const list = paths.map((path) => checkPath(at, path))
      if (list.length === 0) return
      await guarded(() => git.stage(at, list))
      await afterWrite(room)
    },

    async unstage(root, paths) {
      const at = locate(root)
      mustBeOnline()
      const { room, facts } = await mustGit(at)
      const list = new Set(paths.map((path) => checkPath(at, path)))
      // 暂存了的改名：旧名字那一头也要一起退回去，不然暂存区里留着一条“删掉旧名字”
      for (const entry of room.status?.entries ?? []) {
        const path = stripPrefix(entry.path, facts.prefix)
        const from = entry.from === null ? null : stripPrefix(entry.from, facts.prefix)
        if (path !== null && from && list.has(path)) list.add(checkPath(at, from))
      }
      if (list.size === 0) return
      await guarded(() => git.unstage(at, [...list]))
      await afterWrite(room)
    },

    async discard(root, scope, path, expect) {
      const at = locate(root)
      mustBeOnline()
      if (scope === 'staged') {
        throw new ChannelError(
          'rejected',
          '已暂存的改动先取消暂存再还原',
          phrase('diff.notWritable'),
        )
      }
      const { room, facts } = await mustGit(at)
      const wanted = checkPath(at, path)
      await guarded(async () => {
        // 动手之前重新看一眼：确认框开着的这一会儿里文件可能又变了
        const status = await git.status(at)
        const matches = status.entries.filter(
          (item) => stripPrefix(item.path, facts.prefix) === wanted,
        )
        // 暂存区里删了、工作区里又有同名的没跟踪文件时有两条：看“没暂存的”认没跟踪的那条，看全部认跟踪着的那条
        const entry =
          matches.find((item) => (item.kind === 'untracked') === (scope === 'unstaged')) ??
          matches[0]
        const kind = discardKindOf(entry, scope)
        if (kind === 'conflict') {
          throw new ChannelError('rejected', '有冲突的文件不在这里还原', phrase('diff.conflicted'))
        }
        if (kind !== expectedDiscard(expect, scope) || !entry) {
          void refresh(room)
          throw new ChannelError('conflict', '文件的状态变了', phrase('diff.moved'))
        }
        if (kind === 'remove') {
          if (entry.kind === 'untracked') await git.clean(at, [wanted], false)
          else await git.remove(at, [wanted])
        } else if (kind === 'restore') {
          if (scope === 'unstaged') await git.restoreFromIndex(at, [wanted])
          else await git.restoreFromHead(at, [wanted])
        } else if (kind === 'rename') {
          const from = entry.from === null ? null : stripPrefix(entry.from, facts.prefix)
          await git.remove(at, [wanted])
          if (from) await git.restoreFromHead(at, [checkPath(at, from)])
        }
      })
      await afterWrite(room)
    },

    turnEnded() {
      for (const room of rooms.values()) {
        if (room.subs.size === 0) room.stale = true
        else if (host.online()) void refresh(room)
      }
    },

    turnDiff(sessionId, turnId, diff) {
      if (typeof diff !== 'string') return
      turns.delete(sessionId)
      turns.set(sessionId, {
        turnId,
        version: ++stamp,
        files: diff.length > TURN_DIFF_MAX ? null : parsePatch(diff),
      })
      while (turns.size > TURN_KEEP) {
        const oldest = turns.keys().next().value
        if (oldest === undefined) break
        turns.delete(oldest)
      }
      for (const room of rooms.values()) {
        if ([...room.subs].some((sub) => sub.sessionId === sessionId)) publish(room)
      }
    },

    notification(method, params) {
      if (exec.notification(method, params)) return true
      if (method !== 'fs/changed') return false
      const { watchId } = params as ServerNotifications['fs/changed']
      const room = typeof watchId === 'string' ? watched.get(watchId) : undefined
      if (!room) return false
      changed(room)
      return true
    },

    requests() {
      return { spawns: asked.spawns, refreshes: asked.refreshes, byKind: { ...asked.byKind } }
    },

    resync() {
      epoch++
      lacksWatch = false
      watched.clear()
      for (const room of rooms.values()) {
        // 监视是跟着连接走的，上一条连接上的都没了
        room.watches = []
        room.running = null
        room.refreshing = false
        room.arming = false
        room.verified = false
        room.emptyTree = null
        if (room.subs.size > 0) void refresh(room)
        else room.stale = true
      }
    },

    offline() {
      epoch++
      exec.offline()
      watched.clear()
      for (const room of rooms.values()) {
        room.watches = []
        room.running = null
        room.refreshing = false
        room.stopDelay?.()
        room.stopDelay = null
        publish(room)
      }
    },
  }
}
