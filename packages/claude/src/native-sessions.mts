// 列出本机的 Claude Code 会话：别处（命令行、Claude 桌面端）开的会话也出现在这个入口的会话列表里，
// 能打开看历史，也能接着聊。做法照 Pi 入口：先登记进适配器的库，之后和适配器自己建的会话一样读。
//
// - 哪些算：SDK 的 listSessions 列出的、不是程序化入口（sdk-ts、sdk-cli 这些，适配器自己跑的 CLI 也在里面）
//   起的会话；库里记过的原生会话号（适配器自己的、导进来过的、导进来又被删掉的，见 store 的 native_sessions）不算。
// - 列表时（refresh）只登记会话本身：名字、第一句话、目录、时间。历史在会话第一次被读、被恢复、
//   要往里发消息时才画（history），原生记录变了（命令行里又说了几句）再接着画后面的。
// - 原生记录不归适配器管：删掉导进来的会话只是不再导入，原生记录不动；改名只改库里的。
// - Claude 桌面端派出的会话：开头认一次（native-lineage.mts），父会话每次扫描时按桌面端的数据目录重算
//   （desktop-lineage.mts，读不到就是没有父会话）。CHA_CLAUDE_DESKTOP_DATA 指定桌面端的数据目录，给 0 不读。
// - CHA_CLAUDE_NATIVE_SESSIONS=0 关掉整件事。

import type { NativeLineageApp } from '../../protocol/src/native-lineage.mjs'
import { claudeConfigDir } from './claude-native-files.mjs'
import { DesktopLineage } from './desktop-lineage.mjs'
import { type NativeMessage, projectNativeHistory } from './native-history.mjs'
import { findNativeRecords, readNativeLineage } from './native-lineage.mjs'
import type { SessionStore } from './store.mjs'
import type { ThreadRecord } from './types.mjs'

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
   * Claude 桌面端记的父子关系（desktop-lineage.mts）：子会话的会话号 → 父会话用过的会话号（眼下的在前）。
   * 每次扫描都问一遍（桌面端那边会变：新派出的、脱离的）。读不到的给空的
   */
  desktopParents(): Promise<Map<string, readonly string[]>>
}

export function sdkNativeSessionSource(): NativeSessionSource {
  const sdk = () => import('@anthropic-ai/claude-agent-sdk')
  const desktop = new DesktopLineage()
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
    desktopParents: async () => desktop.refresh(),
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

export class NativeSessions {
  private lastRefresh = 0
  /**
   * 导进来的会话 → 它在 Claude 桌面端的父会话（这个入口里的会话标识）。只放在内存里，每次扫描按桌面端的数据重算：
   * 那边随时会变，读不到就是没有父会话
   */
  private parents = new Map<string, string>()
  /** 扫完过一遍了：之后再扫到的新会话才是“刚在别处开的” */
  scanned = false
  private refreshing: Promise<NativeRefresh> | null = null
  /** 正在画历史的会话：同一个会话同时来几次，搭同一趟 */
  private readonly drawing = new Map<string, Promise<void>>()

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
    const known = store.nativeSessions()
    const added: string[] = []
    for (const info of infos) {
      const cwd = info.cwd?.trim()
      if (!cwd || !info.sessionId) continue
      const record = known.get(info.sessionId)
      const updatedAt = seconds(info.lastModified, 0)
      if (!record) {
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
    await this.recognize()
    const fresh = new Set(added)
    const moved = (await this.locate()).filter((id) => !fresh.has(id))
    return { added, moved }
  }

  /** 导进来的会话在 Claude 桌面端的父会话（这个入口里的会话标识）。没有、认不出的是 undefined */
  parentOf(threadId: string): string | undefined {
    return this.parents.get(threadId)
  }

  /**
   * 按 Claude 桌面端记的父子关系重算导进来的会话挂在谁下面（desktop-lineage.mts）。父会话得也是这个入口里的会话
   * （导进来过、没删掉）；父会话用过几个会话号的，取导进来过的里面最新的那个。回父会话变了的会话
   */
  private async locate(): Promise<string[]> {
    const { store, source } = this.host
    let found: Map<string, readonly string[]>
    try {
      found = await source.desktopParents()
    } catch {
      found = new Map()
    }
    const known = store.nativeSessions()
    const threadOf = (sessionId: string): string | undefined => {
      const record = known.get(sessionId)
      if (!record || record.origin === 'dismissed') return undefined
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
   * 导进来的会话：把原生记录里还没画进库的部分画进来。不是导进来的会话、记录没变、正在跑，都不动。
   * 库里最后一个回合的边界（它在原生记录里的最后一条消息）还在原生记录里，就只接着画那之后的；
   * 找不到（别处回退过、分了叉，或者库里的回合没有边界）就整份重画
   */
  history(threadId: string): Promise<void> {
    const running = this.drawing.get(threadId)
    if (running) return running
    const run = this.draw(threadId).finally(() => this.drawing.delete(threadId))
    this.drawing.set(threadId, run)
    return run
  }

  private async draw(threadId: string): Promise<void> {
    const { store, source } = this.host
    let sessionId: string | null = null
    let mark: string | null = null
    for (const [id, record] of store.nativeSessions()) {
      if (record.threadId !== threadId || record.origin !== 'imported') continue
      sessionId = id
      mark = record.mark
    }
    const thread = store.getThread(threadId)
    if (!sessionId || !thread || this.host.busy(threadId)) return
    const info = await source.info(sessionId, thread.cwd)
    if (!info) return
    const now = markOf(info)
    if (now === mark) return
    const messages = await source.messages(sessionId, thread.cwd)
    if (this.host.busy(threadId)) return
    const turns = store.listTurns(threadId)
    const last = turns.at(-1)
    const boundary = last ? store.nativeBoundary(last.id) : null
    const from = boundary ? messages.findIndex((message) => message.uuid === boundary) + 1 : 0
    const keep = from > 0 ? turns.length : 0
    const drawn = projectNativeHistory(
      threadId,
      keep > 0 ? messages.slice(from) : messages,
      thread.cwd,
    )
    // 接着画的时候，原生记录里新的这段可能和库里已有的回合同号（同一份记录画过一遍）：跳过已有的
    const have = new Set(keep > 0 ? turns.map((turn) => turn.id) : [])
    const fresh = drawn.turns.filter((turn) => !have.has(turn.id))
    store.replaceNativeHistory(threadId, sessionId, keep, fresh, drawn.boundaries, now)
  }
}
