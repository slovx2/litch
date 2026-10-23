// 列出本机的 Claude Code 会话：别处（命令行、Claude 桌面端）开的会话也出现在这个入口的会话列表里，
// 能打开看历史，也能接着聊。做法照 Pi 入口：先登记进适配器的库，之后和适配器自己建的会话一样读。
//
// - 哪些算：SDK 的 listSessions 列出的、不是程序化入口（sdk-ts、sdk-cli 这些，适配器自己跑的 CLI 也在里面）
//   起的会话；库里记过的原生会话号（适配器自己的、导进来过的、导进来又被删掉的，见 store 的 native_sessions）不算。
// - 列表时（refresh）只登记会话本身：名字、第一句话、目录、时间。历史在会话第一次被读、被恢复、
//   要往里发消息时才画（history），原生记录变了（命令行里又说了几句）再接着画后面的；有连接订阅着时
//   服务每隔几秒看一次（server.mts 的 followNative），变了就重画并通知。
// - 被别处的进程开着时（native-owner.mts）只读：画照样画，会写原生记录的请求由服务拒掉。
// - 原生记录不归适配器管：删掉导进来的会话只是不再导入，原生记录不动；改名只改库里的。
// - Claude 桌面端派出的会话：开头认一次（native-lineage.mts），父会话每次扫描时按桌面端的数据目录重算
//   （desktop-lineage.mts，读不到就是没有父会话）。CHA_CLAUDE_DESKTOP_DATA 指定桌面端的数据目录，给 0 不读。
// - Claude 桌面端换下来的旧会话号（回退、追加上下文时换号，新号的记录里带着旧号的全部对话）不列：没导进来的不导，
//   导进来过的从列表里藏起来（不删，桌面端的数据读不到了就又列出来）。换下来之后旧记录还有人接着写过的照列。
// - CHA_CLAUDE_NATIVE_SESSIONS=0 关掉整件事。

import type { NativeLineageApp } from '../../protocol/src/native-lineage.mjs'
import type { NativeOwner } from '../../protocol/src/native-owner.mjs'
import { claudeConfigDir } from './claude-native-files.mjs'
import { type DesktopIndex, DesktopLineage } from './desktop-lineage.mjs'
import { type NativeMessage, projectNativeHistory } from './native-history.mjs'
import { findNativeRecords, readNativeLineage } from './native-lineage.mjs'
import { recentlyWritten } from './native-owner.mjs'
import { type NativeRecordFacts, readNativeRecordFacts } from './native-record.mjs'
import type { PeerLookup } from './peer-target.mjs'
import type { SessionStore } from './store.mjs'
import type { ThreadRecord, TurnRecord } from './types.mjs'

/** SDK 给的会话信息里用到的那几项 */
export interface NativeSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  cwd?: string
  createdAt?: number
}

/** 读原生会话的那两样。平时是 SDK，测试里可以换 */
export interface NativeSessionSource {
  list(): Promise<NativeSessionInfo[]>
  info(sessionId: string, cwd: string): Promise<NativeSessionInfo | undefined>
  messages(sessionId: string, cwd: string): Promise<NativeMessage[]>
  /** 这几个会话各是不是别的应用派出来的（native-lineage.mts）。读不到的也给一个结果（null） */
  lineage(sessionIds: readonly string[]): Promise<Map<string, NativeLineageApp | null>>
  /**
   * Claude 桌面端的数据（desktop-lineage.mts）：父子关系、换下来的旧会话号。
   * 每次扫描都问一遍（桌面端那边会变：新派出的、脱离的、换了号的）。读不到的给空的
   */
  desktop(): Promise<DesktopIndex>
  /** 原生记录（jsonl）的路径，找不到是 null */
  record(sessionId: string): string | null
}

export function sdkNativeSessionSource(): NativeSessionSource {
  const sdk = () => import('@anthropic-ai/claude-agent-sdk')
  const desktopIndex = new DesktopLineage()
  return {
    list: async () => (await sdk()).listSessions({ includeProgrammatic: false }),
    info: async (sessionId, cwd) => (await sdk()).getSessionInfo(sessionId, { dir: cwd }),
    messages: async (sessionId, cwd) =>
      (await (await sdk()).getSessionMessages(sessionId, { dir: cwd })) as NativeMessage[],
    lineage: async (sessionIds) => {
      const paths = findNativeRecords(claudeConfigDir(), sessionIds)
      return new Map(
        sessionIds.map((id) => {
          const path = paths.get(id)
          return [id, path ? readNativeLineage(path) : null]
        }),
      )
    },
    desktop: async () => desktopIndex.refresh(),
    record: (sessionId) => findNativeRecords(claudeConfigDir(), [sessionId]).get(sessionId) ?? null,
  }
}

export const nativeSessionsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CHA_CLAUDE_NATIVE_SESSIONS !== '0'

/** 这一份原生记录的记号：大小和修改时间，变了就是有新内容 */
const markOf = (info: NativeSessionInfo): string => `${info.fileSize ?? -1}:${info.lastModified}`

const seconds = (ms: number | undefined, fallback: number): number =>
  typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback

/** 会话的名字：用户起的名字，其次是 CLI 自己总结的（和第一句话一样就不算名字） */
function nameOf(info: NativeSessionInfo): string | null {
  if (info.customTitle?.trim()) return info.customTitle.trim()
  const summary = info.summary?.trim()
  return summary && summary !== info.firstPrompt?.trim() ? summary : null
}

export interface NativeSessionsHost {
  store: SessionStore
  source: NativeSessionSource
  /** 给一个原生会话建会话记录（模型、权限这些照新建会话的默认来） */
  newThread(fields: {
    id: string
    cwd: string
    preview: string
    name: string | null
    createdAt: number
    updatedAt: number
  }): ThreadRecord
  /** 这个会话现在有回合在跑：不去动它的历史 */
  busy(threadId: string): boolean
  /** 本机交互进程的登记里占着的原生会话：原生会话号 → 占用方（native-owner.mts）。fresh 时不用缓存 */
  registered(fresh?: boolean): Map<string, NativeOwner>
  /** 入口自己的 CLI 在这个会话上：此刻开着没有、最后一次退出的时刻（毫秒） */
  ownCli(threadId: string): { alive: boolean; exitedAt: number }
  /** 认收件箱地址用的本机登记和 Litch 会话（peer-target.mts）。不给时只靠记录里收到过的消息 */
  peers?: Omit<PeerLookup, 'seen'>
}

/** 重画了一遍：画之前、之后的回合，和顺手从原生记录里读的占用、设置（读不到记录是 null） */
export interface NativeRedraw {
  sessionId: string
  before: TurnRecord[]
  after: TurnRecord[]
  facts: NativeRecordFacts | null
}

/** 列表时两次扫描至少隔这么久；中间来的列表用上一次的结果 */
const REFRESH_GAP_MS = 2000

/** 一次扫描的结果 */
export interface NativeRefresh {
  /** 新登记的会话 */
  added: string[]
  /** 已经登记过、这次父会话变了的会话（桌面端新记了、脱离了，父会话刚导进来、没了） */
  moved: string[]
}

const NOTHING: NativeRefresh = { added: [], moved: [] }

/** 旧号的记录在新号开始之后这么久还在写，算有人接着用旧号聊过（换号那一刻旧记录可能还收个尾） */
const REPLACED_SLACK_MS = 60_000

/**
 * 桌面端换下来、不该再列的旧会话号：后来换上的号也在列表里，旧记录在那之后没人接着写过。
 * 新号的记录是从旧号复制出来的（开头时刻和旧号一样）时看不出先后，也算换下来了
 */
function replacedSessions(
  replacedBy: ReadonlyMap<string, readonly string[]>,
  infos: ReadonlyMap<string, NativeSessionInfo>,
): Set<string> {
  const result = new Set<string>()
  for (const [id, later] of replacedBy) {
    const old = infos.get(id)
    const next = later.map((candidate) => infos.get(candidate)).find((info) => info !== undefined)
    if (!old || !next) continue
    const started = next.createdAt ?? 0
    const continued =
      started > (old.createdAt ?? 0) && old.lastModified > started + REPLACED_SLACK_MS
    if (!continued) result.add(id)
  }
  return result
}

export class NativeSessions {
  private lastRefresh = 0
  /**
   * 导进来的会话 → 它在 Claude 桌面端的父会话（这个入口里的会话标识）。只放在内存里，每次扫描按桌面端的数据重算：
   * 那边随时会变，读不到就是没有父会话
   */
  private parents = new Map<string, string>()
  /** 导进来过、这次扫描算出是桌面端换下来的旧号的会话：列表里不列。也只放在内存里，每次扫描重算 */
  private hidden = new Set<string>()
  /** 扫完过一遍了：之后再扫到的新会话才是“刚在别处开的” */
  scanned = false
  private refreshing: Promise<NativeRefresh> | null = null
  /** 正在画历史的会话：同一个会话同时来几次，搭同一趟 */
  private readonly drawing = new Map<string, Promise<NativeRedraw | null>>()
  /** 找到过的原生记录：原生会话号 → 路径 */
  private readonly paths = new Map<string, string>()

  private readonly host: NativeSessionsHost

  constructor(host: NativeSessionsHost) {
    this.host = host
  }

  /** 扫一遍本机的原生会话，新的登记进库，登记过的更新名字和时间。回新登记的、父会话变了的会话标识 */
  refresh(force = false): Promise<NativeRefresh> {
    if (this.refreshing) return this.refreshing
    if (!force && Date.now() - this.lastRefresh < REFRESH_GAP_MS) return Promise.resolve(NOTHING)
    const run = this.scan()
      .then((result) => {
        this.scanned = true
        return result
      })
      .finally(() => {
        this.lastRefresh = Date.now()
        this.refreshing = null
      })
    this.refreshing = run
    return run
  }

  private async scan(): Promise<NativeRefresh> {
    const { store, source } = this.host
    const infos = await source.list()
    let desktop: DesktopIndex
    try {
      desktop = await source.desktop()
    } catch {
      desktop = { parents: new Map(), replacedBy: new Map() }
    }
    const replaced = replacedSessions(
      desktop.replacedBy,
      new Map(infos.map((info) => [info.sessionId, info])),
    )
    const known = store.nativeSessions()
    const added: string[] = []
    for (const info of infos) {
      const cwd = info.cwd?.trim()
      if (!cwd || !info.sessionId) continue
      const record = known.get(info.sessionId)
      const updatedAt = seconds(info.lastModified, 0)
      if (!record) {
        if (replaced.has(info.sessionId)) continue
        const preview = info.firstPrompt?.trim() || info.summary?.trim() || ''
        // 一句话都没说过的（只开了个头就关了）不列，和别的入口一样
        if (!preview) continue
        // 会话号就是原生的会话号：设备层按标识认会话属于哪个 harness，UUID 不会和别家撞
        const thread = this.host.newThread({
          id: info.sessionId,
          cwd,
          preview,
          name: nameOf(info),
          createdAt: seconds(info.createdAt, updatedAt),
          updatedAt,
        })
        store.importNativeSession(info.sessionId, thread)
        added.push(thread.id)
        continue
      }
      if (record.origin !== 'imported') continue
      const thread = store.getThread(record.threadId)
      if (!thread || this.host.busy(thread.id)) continue
      const name = thread.name ?? nameOf(info)
      if (updatedAt > thread.updatedAt || name !== thread.name)
        store.upsertThread({ ...thread, name, updatedAt: Math.max(updatedAt, thread.updatedAt) })
    }
    this.hidden = new Set(
      [...replaced].flatMap((id) => {
        const record = known.get(id)
        return record?.origin === 'imported' ? [record.threadId] : []
      }),
    )
    await this.recognize()
    const fresh = new Set(added)
    const moved = this.locate(desktop.parents).filter((id) => !fresh.has(id))
    return { added, moved }
  }

  /** 列表里不列的会话（桌面端换下来的旧号，见 scan） */
  hiddenThreads(): ReadonlySet<string> {
    return this.hidden
  }

  /** 导进来的会话在 Claude 桌面端的父会话（这个入口里的会话标识）。没有、认不出的是 undefined */
  parentOf(threadId: string): string | undefined {
    return this.parents.get(threadId)
  }

  /**
   * 按 Claude 桌面端记的父子关系重算导进来的会话挂在谁下面（desktop-lineage.mts）。父会话得也是这个入口里的会话
   * （导进来过、没删掉、没藏起来）；父会话用过几个会话号的，取导进来过的里面最新的那个。回父会话变了的会话
   */
  private locate(found: ReadonlyMap<string, readonly string[]>): string[] {
    const { store } = this.host
    const known = store.nativeSessions()
    const threadOf = (sessionId: string): string | undefined => {
      const record = known.get(sessionId)
      if (!record || record.origin === 'dismissed' || this.hidden.has(record.threadId))
        return undefined
      return store.getThread(record.threadId) ? record.threadId : undefined
    }
    const next = new Map<string, string>()
    for (const [childId, candidates] of found) {
      const record = known.get(childId)
      if (!record || record.origin !== 'imported') continue
      const child = threadOf(childId)
      if (!child) continue
      for (const candidate of candidates) {
        const parent = threadOf(candidate)
        if (!parent || parent === child) continue
        next.set(child, parent)
        break
      }
    }
    // 桌面端的数据要是绕成了圈，侧栏里这一圈谁都不在顶层、全看不见：圈上的都不挂
    for (const start of [...next.keys()]) {
      const path = new Set<string>()
      let at: string | undefined = start
      while (at !== undefined && !path.has(at)) {
        path.add(at)
        at = next.get(at)
      }
      if (at === start) for (const id of path) next.delete(id)
    }
    const moved = [...new Set([...this.parents.keys(), ...next.keys()])].filter(
      (id) => this.parents.get(id) !== next.get(id),
    )
    this.parents = next
    return moved
  }

  /**
   * 导进来的会话里还没认过的：认一遍是不是别的应用派出来的，结果记进库（每个只认一次）。
   * 有这一步之前导进来的会话也在这里补认。认不出来不影响导入
   */
  private async recognize(): Promise<void> {
    const { store, source } = this.host
    const checked = store.nativeLineage()
    const pending = [...store.nativeSessions()]
      .filter(([id, record]) => record.origin === 'imported' && !checked.has(id))
      .map(([id]) => id)
    if (pending.length === 0) return
    let found: Map<string, NativeLineageApp | null>
    try {
      found = await source.lineage(pending)
    } catch {
      return
    }
    for (const id of pending) store.saveNativeLineage(id, found.get(id) ?? null)
  }

  /**
   * 导进来的会话：把原生记录里还没画进库的部分画进来，回画之前和之后的回合（没动是 null）。
   * 不是导进来的会话、记录没变、入口自己正在跑它，都不动。怎么接着画：
   * - 库里末尾是导进来的回合（回合标识就是它在原生记录里的第一条消息）：从它的开头起整段重画、替换掉它。
   *   别处跑到一半时画过的回合这样就补全了；没有人话打头、又不是记录开头的（以前跑到一半时拆出来的半截）
   *   再往前找到有头的那一个。
   * - 末尾是入口自己跑的回合：它的边界（在原生记录里的最后一条消息）还在，就只接着画那之后的。
   * - 都对不上：记录里压缩过的，只在压缩之后接着画（压缩后的链里没有以前的消息），旧回合一个不删；
   *   没压缩过的（别处回退过、分了叉）整份重画
   */
  history(threadId: string): Promise<NativeRedraw | null> {
    const running = this.drawing.get(threadId)
    if (running) return running
    const run = this.draw(threadId).finally(() => this.drawing.delete(threadId))
    this.drawing.set(threadId, run)
    return run
  }

  /** 导进来的会话对应的原生会话号和画过的那份记录的记号。不是导进来的是 null */
  private imported(threadId: string): { sessionId: string; mark: string | null } | null {
    for (const [id, record] of this.host.store.nativeSessions())
      if (record.threadId === threadId && record.origin === 'imported')
        return { sessionId: id, mark: record.mark }
    return null
  }

  /** 原生记录的路径。找过的记下来（记录不会搬家）；找不到不记，下次再找 */
  private recordPath(sessionId: string): string | null {
    const known = this.paths.get(sessionId)
    if (known) return known
    const found = this.host.source.record(sessionId)
    if (found) this.paths.set(sessionId, found)
    return found
  }

  /**
   * 这几个会话里被别处占着的（native-owner.mts）：只看导进来的。growth 为真时登记里没有的再看原生记录
   * 是不是刚被别人改过（要找记录、看文件，列表时不做）。fresh 时重读登记，不用一秒内读过的
   */
  owners(threadIds: readonly string[], growth = true, fresh = false): Map<string, NativeOwner> {
    const found = new Map<string, NativeOwner>()
    const imported = this.importedAmong(threadIds)
    let registered: Map<string, NativeOwner> | null = null
    for (const threadId of threadIds) {
      const sessionId = imported.get(threadId)
      if (!sessionId) continue
      registered ??= this.host.registered(fresh)
      const owner = registered.get(sessionId)
      if (owner) {
        found.set(threadId, owner)
        continue
      }
      if (!growth) continue
      const own = this.host.ownCli(threadId)
      if (recentlyWritten(this.recordPath(sessionId), own.alive, own.exitedAt))
        found.set(threadId, { entrypoint: 'unknown', running: true })
    }
    return found
  }

  /** 这几个会话里导进来的：会话 → 原生会话号 */
  importedAmong(threadIds: readonly string[]): Map<string, string> {
    const wanted = new Set(threadIds)
    const found = new Map<string, string>()
    if (wanted.size === 0) return found
    for (const [id, record] of this.host.store.nativeSessions())
      if (record.origin === 'imported' && wanted.has(record.threadId))
        found.set(record.threadId, id)
    return found
  }

  owner(threadId: string): NativeOwner | null {
    return this.owners([threadId]).get(threadId) ?? null
  }

  private async draw(threadId: string): Promise<NativeRedraw | null> {
    const { store, source } = this.host
    const known = this.imported(threadId)
    const thread = store.getThread(threadId)
    if (!known || !thread || this.host.busy(threadId)) return null
    const { sessionId } = known
    const info = await source.info(sessionId, thread.cwd)
    if (!info) return null
    const running = this.owner(threadId)?.running === true
    const now = `${markOf(info)}${running ? ':running' : ''}`
    // 记录没变：除非最后一个回合的进行中和对方在不在跑对不上（入口重启时把进行中的回合收成了中断）
    const last = store.listTurns(threadId).at(-1)
    if (now === known.mark && running === (last?.status === 'inProgress')) return null
    const messages = await source.messages(sessionId, thread.cwd)
    // 从这里到写进库之间不再等别的：入口自己的回合是同步建的，这时没开始就不会插进来
    if (this.host.busy(threadId)) return null
    const before = store.listTurns(threadId)
    const path = this.recordPath(sessionId)
    const facts = path ? readNativeRecordFacts(path) : null
    const at = new Map(messages.map((message, index) => [message.uuid, index]))
    let keep = before.length
    let from = -1
    for (let index = before.length - 1; index >= 0; index--) {
      const start = at.get(before[index]?.id ?? '')
      if (start === undefined) break
      keep = index
      from = start
      if (start === 0 || messages[start]?.type === 'user') break
    }
    if (from < 0) {
      const tail = before.at(-1)
      const boundary = tail ? store.nativeBoundary(tail.id) : null
      const after = boundary ? at.get(boundary) : undefined
      if (after !== undefined) from = after + 1
      else if (tail && facts?.compacted) {
        // 从压缩后的摘要接着画；链里找不到摘要就整条链都画，已经有的回合跳过
        const summary = messages.findLastIndex((message) => message.isCompactSummary === true)
        from = Math.max(0, summary)
      } else {
        keep = 0
        from = 0
      }
    }
    const drawn = projectNativeHistory(threadId, messages.slice(from), thread.cwd, {
      running,
      ...(this.host.peers ? { peers: this.host.peers } : {}),
    })
    // 原生记录里新的这段可能和库里留着的回合同号（同一份记录画过一遍、压缩后留下的那一段）：跳过已有的
    const have = new Set(before.slice(0, keep).map((turn) => turn.id))
    const fresh = drawn.turns.filter((turn) => !have.has(turn.id))
    store.replaceNativeHistory(threadId, sessionId, keep, fresh, drawn.boundaries, now)
    for (const [turnId, origin] of drawn.origins)
      if (!have.has(turnId)) store.saveTurnOrigin(turnId, origin)
    return { sessionId, before, after: store.listTurns(threadId), facts }
  }
}
