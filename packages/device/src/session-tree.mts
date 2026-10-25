// 会话树（sessionTree 扩展，protocol/extensions/session-tree.json）在设备进程里的主体：
// 父子关系、提案、回报队列、唤醒。派子会话的做法在 session-start.mts，模型用的 litch_sessions 在 session-tools.mts。
//
// 设备进程自己对每个 harness 开一条引擎连接（engine-link.mts，按需开、断了下次再开），用它建子会话、发回合、
// 读会话，并订阅它建的子会话：子会话一回合结束，哪怕没有客户端开着它，设备进程也收得到。
// 回合的开始与结束还从各条客户端连接的上游上看（relay.mts 调 turnEvent），两边按回合号去重。
//
// 回报：子会话一回合结束，取最后一条回答前 400 字进父会话的队列（sessions.sqlite）。父会话有回合在跑的，当场把排着的
// 包成 kind=notes 的一段插进那个回合（steerNotes，turn/steer），插成了就出队列；插不进（回合正在收尾、引擎不会插话）的
// 留着，父会话下一个由客户端发起的回合把它们放在用户消息前面（beforeUserTurn），或者唤醒时交出去。
// 队列一变就发 litch/thread/queuedNotes/updated，客户端不等交给模型就把排着的回报画在父会话对话区的末尾。
// 唤醒：有客户端连着、开关开着、父会话闲着、它没脱离的直接子会话都停下了（在等用户答的挂满 needsUserMs 也算停下）、
// 队列里有该唤醒的回报、上一条用户消息之后唤醒不到 10 次，设备进程替父会话发一个 kind=wake 的回合。
// 出错、被打断的回合，用户自己、定时任务发起的回合，用户停下的子会话，回报都不算该唤醒的。
// 提醒收尾：会话带着 wrap_up、用户亲手发起的回合正常结束（completed）时这一回合没调过 wrap_up，
// 设置里“每回合收尾”和提醒都开着，设备进程替它再开一个 kind=remind 的回合。提醒回合、唤醒回合、定时任务的回合都不是用户发起的，
// 不会再引出提醒，所以一条用户消息之后最多一次。提醒和唤醒排在同一条检查队列里（check），先提醒、后唤醒：
// 会话有回合在跑时谁都不发，那个回合结束时再查一遍；提醒发出之前用户又说了话、或者别的回合里调了 wrap_up，提醒作废。
// offer 卡（litch_sessions.start 的 initiation offer）：模型那次调用一直等着（offers），用户在卡上选了（answerOffer）、
// 又发了话（turn/start、turn/steer）、打断了回合、回合结束了，都让它了结；选了新会话的（chosen）等模型 accept 补简报，
// 回合结束还没补的当作在这里做。设备进程重启时上一次还在等的一律当作在这里做。
// 普通提案卡上的“在这里做”（proposalHere）：提案记 here，往父会话发一条用户消息，父会话在跑就排到回合结束后
//（check 里先发它，再提醒、唤醒）。任务卡按 harness 关着（host.taskCards）时，新会话挑没有建议的那组工具
//（currentSessionTools），已经带着 wrap_up 的会话也不再提醒。
import { randomUUID } from 'node:crypto'
import type { LitchBackgroundTask } from '../../protocol/src/background-tasks.mjs'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { SESSION_TOOL, sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  formatSessionEvent,
  SESSION_TREE_LIMITS,
  SESSION_TREE_NOTIFICATION,
  type SessionEventNote,
  type SessionLineage,
  type SessionProposal,
  type SessionQueuedNote,
} from '../../protocol/src/session-tree.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { HarnessSource } from './session.mjs'
import type { SessionStore } from './session-store.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { DeviceError, isObject, UpstreamRpcError } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'
import type { Worktrees } from './worktrees.mjs'

export interface SessionTreeHost {
  harnesses(): HarnessSource[]
  openEngineLink(harness: string): Promise<EngineLink>
  index: ThreadIndex
  workspaces: Workspaces
  store: SessionStore
  /** 设备层的工作树。没有 git 时是 null：子会话一律共用父会话的目录 */
  worktrees: Worktrees | null
  /** 设置里“会话编排”开着 */
  enabled(): boolean
  /** 现在握手完成的客户端连接有几条 */
  clients(): number
  /** 发给全部声明了 extension 的客户端连接 */
  announce(method: string, params: unknown, extension: string): void
  /** 设备进程建出来的会话：给每条客户端连接发一条标准的 thread/started（各自挂上 harness、工作区、litchLineage） */
  threadStarted(harness: string, thread: Record<string, unknown>): void
  timeoutMs: number
  /** 子会话里的审批、提问挂了这么久没人答，算它停下来在等用户 */
  needsUserMs: number
  /** 会话树的连接订阅着、又用不着了的会话，隔这么久退订 */
  releaseMs: number
  /** 这个回合是定时任务发起的：只进回报，不唤醒父会话 */
  taskTurn(threadId: string, turnId: string): boolean
  /** 会话里还有几个后台任务在跑（background.mts） */
  backgroundRunning(threadId: string): number
  /** 会话的后台任务集合（background.mts） */
  backgroundTasks(threadId: string): LitchBackgroundTask[]
  /** 后台任务跑完了引擎会不会自己接着做（background.mts 的 wakes） */
  backgroundWakes(threadId: string): boolean
  /** 设置里“每回合收尾”开着（sessions.wrapUp）：关掉时新会话的 litch_sessions 里没有 wrap_up，也不提醒 */
  wrapUp(): boolean
  /** 设置里“提醒收尾”开着（sessions.wrapUpReminder） */
  wrapUpReminder(): boolean
  /**
   * 这个 harness 的“任务卡”开着（harness.<id>.taskCards，默认开）：关着时新会话的 litch_sessions 是没有建议的那一份，
   * 已有会话的建议当场不落提案、offer 当在这里做、不提醒收尾
   */
  taskCards(harness: string): boolean
  log(line: string): void
}

/** 会话对象上的一段文字，掐成 limit 个字以内：留头留尾，中间换成省略号（和客户端附摘录时用同一份） */
export { trimText } from '../../protocol/src/session-mentions.mjs'

/** 一个回合里最后一条回答的正文。没有是 null */
export function lastAnswer(turn: unknown): string | null {
  const items = isObject(turn) && Array.isArray(turn.items) ? turn.items : []
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]
    if (isObject(item) && item.type === 'agentMessage' && typeof item.text === 'string')
      return item.text
  }
  return null
}

const now = () => Math.floor(Date.now() / 1000)

/** 记着的“已经结束的回合”最多这么多个，满了清掉重来（只用来认出迟到的“开始”） */
const ENDED_LIMIT = 10_000

/** 设备进程到某个 harness 的连接断了之后，隔多久重开（毫秒），一次比一次久 */
const REWATCH_MS = [1000, 2000, 5000, 10_000, 30_000]

/** offer 卡怎么了结的：用户选的（answered）、用户没选又发了话（spoke）、回合被打断（interrupted）、回合结束了（ended） */
export interface OfferOutcome {
  choice: 'session' | 'here'
  reason: 'answered' | 'spoke' | 'interrupted' | 'ended'
}

/** 一张在等用户选的 offer 卡：那次 start 调用在等它 */
interface OfferWait {
  threadId: string
  turnId: string
  resolve: (outcome: OfferOutcome) => void
}

export class SessionTree {
  readonly host: SessionTreeHost
  private readonly links = new Map<string, Promise<EngineLink>>()
  /** 每条引擎连接订阅了哪些会话 */
  private readonly subscribed = new Map<string, Set<string>>()
  /** 等着看要不要退订的会话 → 计时器 */
  private readonly releasing = new Map<string, NodeJS.Timeout>()
  /** 正在退订的会话：这时要再订阅的先等它退完，免得引擎把两个请求倒过来处理 */
  private readonly unsubscribing = new Map<string, Promise<void>>()
  /** 在跑的回合：会话 → 回合 */
  private readonly active = new Map<string, string>()
  /** 客户端用 turn/start 发起的回合（harness + 回合）：只有它们算用户发起的 */
  private readonly clientTurns = new Set<string>()
  /**
   * 用户亲手停下的子会话（客户端的 turn/interrupt、归档）：会话 → 怎么停的。它在跑的回合结束时取走，
   * 那条回报注明是用户停的、不唤醒父会话。模型用 litch_sessions 打断的走设备进程自己的连接，不经过这里
   */
  private readonly userStops = new Map<string, 'interrupted' | 'archived'>()
  /** 模型用 litch_sessions 归档的会话（session-archive.mts）：引擎发回的 thread/archived 不算用户归档 */
  readonly modelArchived = new Set<string>()
  /** 子会话里挂着没人答的请求：会话 → 请求号 → 开始挂的时刻（毫秒） */
  private readonly waiting = new Map<string, Map<string, number>>()
  /** 已经为“在等用户”进过一次队列的回合，同一个回合只报一次 */
  private readonly askedOnce = new Set<string>()
  /**
   * 已经结束的回合（会话 + 回合）。同一个回合的通知从好几条连接各来一份，各走各的套接字：
   * 一条连接上的“开始”可能排在另一条连接上的“结束”后面到，认出来的就不再当它在跑
   */
  private readonly ended = new Set<string>()
  /** 调过 litch_sessions.wrap_up 的回合（会话 + 回合）：回合结束时看一眼就删 */
  private readonly wrapped = new Set<string>()
  /** 该提醒收尾、还没发出去的会话 → 没调收尾的那个用户回合 */
  private readonly reminders = new Map<string, string>()
  /** 提醒回合（会话 + 回合）→ 它替哪个用户回合提醒：一回合几张提案的门槛把两个回合合起来算 */
  private readonly remindedFor = new Map<string, string>()
  /**
   * 上一次回报写了还有后台任务在跑的子会话：跑完了要再报一次。值是回报时在跑的那几个任务，
   * byUser 是这之后用户在后台任务页上停过它的命令（客户端的 thread/backgroundTerminals/terminate、clean）
   */
  private readonly backgroundOwed = new Map<string, { tasks: Set<string>; byUser: boolean }>()
  /** 回合结束时要叫醒的（wait 工具在等） */
  private readonly listeners = new Set<(threadId: string) => void>()
  /** 每个父会话的唤醒检查排成一条，免得一次结束触发两个唤醒 */
  private readonly checks = new Map<string, Promise<void>>()
  private readonly timers = new Set<NodeJS.Timeout>()
  /** 在等用户选的 offer 卡：提案 → 等它的那次调用 */
  private readonly offers = new Map<string, OfferWait>()
  /** 提案卡上点了“在这里做”、还没发出去的用户消息：会话 → 按先后排的几条（会话在跑时排到回合结束后发） */
  private readonly heres = new Map<string, string[]>()
  /** markHere 了结的提案交回去的那句话（设备进程活着时重复问回同一句） */
  private readonly marked = new Map<string, string>()
  /** 回报插话不认识 turn/steer 的 harness（-32601）：这次运行里不再去插，回报照旧排着 */
  private readonly noSteer = new Set<string>()
  /**
   * 回报插话的消息号：litch-sessions-<这次运行的记号>-<序号>。入口按“会话 + 消息号”永久记账，
   * 只用序号的话设备进程重启后会撞上以前用过的号（同客户端的做法）
   */
  private readonly runMark = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  private steerSeq = 0
  private expiry: NodeJS.Timeout | null = null
  private recovered = false
  private closed = false

  constructor(host: SessionTreeHost) {
    this.host = host
    // 上一次设备进程里还在等的 offer 卡：等它的那次调用跟着进程没了，模型那边已经拿到失败，当作在这里做
    const settled = host.store.settleOffers()
    if (settled > 0) host.log(`上一次还在等的 ${settled} 张 offer 卡当作在这里做了结`)
    this.scheduleExpiry()
  }

  get store(): SessionStore {
    return this.host.store
  }

  // ---------- 引擎连接 ----------

  /** 设备进程到这个 harness 的那条连接。断了的下次再开 */
  link(harness: string): Promise<EngineLink> {
    let pending = this.links.get(harness)
    if (!pending) {
      pending = this.host.openEngineLink(harness).then((link) => {
        const threads = new Set<string>()
        this.subscribed.set(harness, threads)
        link.onNotification((method, params) => this.engineEvent(harness, method, params))
        link.onServerRequest((_method, params, id) => this.asked(params, id))
        link.onClose(() => {
          if (this.links.get(harness) === pending) this.links.delete(harness)
          if (this.subscribed.get(harness) === threads) this.subscribed.delete(harness)
          // 订阅跟着连接没了：这个 harness 上在跑的子会话要重新盯上，不然收不到它们的回合结束
          if (!this.closed) this.rewatch(harness, 0)
        })
        if (this.closed) link.close()
        return link
      })
      const opened = pending
      opened.catch(() => {
        if (this.links.get(harness) === opened) this.links.delete(harness)
      })
      this.links.set(harness, opened)
    }
    return pending
  }

  /** 这条连接订阅着这个会话了（新建、分叉出来的，或者刚恢复过） */
  noteSubscribed(harness: string, threadId: string): void {
    this.subscribed.get(harness)?.add(threadId)
  }

  /** 让设备进程的连接订阅这个会话（收它的回合通知）。返回 thread/resume 的应答，已经订阅过的是 null */
  async watch(harness: string, threadId: string): Promise<Record<string, unknown> | null> {
    this.keep(threadId)
    await this.unsubscribing.get(threadId)
    const link = await this.link(harness)
    if (this.subscribed.get(harness)?.has(threadId)) return null
    const result = await link.request('thread/resume', { threadId })
    this.noteSubscribed(harness, threadId)
    return isObject(result) ? result : null
  }

  /**
   * 过 releaseMs 看一眼：设备进程的连接订阅着这个会话、又用不着了（没有回合在跑、不欠后台任务的回报、
   * 没有挂着的请求），就退订。不退的话引擎一直装着它：原生 codex 只卸载没人订阅的会话，卸载了才放开
   * 写入锁，设备进程常驻，ChatGPT.app 等别的应用就一直打不开这个会话
   */
  releaseLater(harness: string, threadId: string): void {
    if (this.closed || !this.subscribed.get(harness)?.has(threadId)) return
    this.keep(threadId)
    const timer = setTimeout(() => {
      this.releasing.delete(threadId)
      if (!this.closed) this.release(harness, threadId)
    }, this.host.releaseMs)
    timer.unref()
    this.releasing.set(threadId, timer)
  }

  /** 又要用这个会话了：不退订 */
  private keep(threadId: string): void {
    const timer = this.releasing.get(threadId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.releasing.delete(threadId)
  }

  private release(harness: string, threadId: string): void {
    const threads = this.subscribed.get(harness)
    const pending = this.links.get(harness)
    if (!threads?.has(threadId) || !pending) return
    if (
      this.active.has(threadId) ||
      this.backgroundOwed.has(threadId) ||
      this.waiting.has(threadId)
    )
      return
    threads.delete(threadId)
    const done = pending
      .then((link) => link.request('thread/unsubscribe', { threadId }))
      .then(
        () => {},
        (error: unknown) =>
          this.host.log(`退订会话 ${threadId}（${harness}）没成：${String(error)}`),
      )
      .finally(() => {
        if (this.unsubscribing.get(threadId) === done) this.unsubscribing.delete(threadId)
      })
    this.unsubscribing.set(threadId, done)
  }

  /** 会话在哪个 harness 上：索引里有的直接给，没有的挨个问 */
  async owner(threadId: string): Promise<string> {
    const known = this.host.index.lookup(threadId)
    if (known) return known
    for (const source of this.host.harnesses()) {
      try {
        const link = await this.link(source.id)
        const result = await link.request('thread/read', { threadId, includeTurns: false })
        const thread = isObject(result) ? result.thread : null
        if (isObject(thread) && thread.id === threadId) {
          this.host.index.see(
            { id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
            source.id,
          )
          return source.id
        }
      } catch {
        // 这个 harness 不认识它，或者现在不可用：问下一个
      }
    }
    throw new DeviceError('unknownThread', `没有哪个 harness 认识会话 ${threadId}`, { threadId })
  }

  /** 读一个会话（thread/read） */
  async read(
    threadId: string,
    includeTurns: boolean,
  ): Promise<{ harness: string; thread: Record<string, unknown> }> {
    const harness = await this.owner(threadId)
    const link = await this.link(harness)
    const result = await link.request('thread/read', { threadId, includeTurns })
    const thread = isObject(result) && isObject(result.thread) ? result.thread : null
    if (!thread) throw new Error(`${harness} 没有给回会话 ${threadId}`)
    return { harness, thread }
  }

  // ---------- 回合与请求 ----------

  /** 客户端用 turn/start 发起的回合（turn/start 的应答回来了） */
  clientTurn(harness: string, turnId: string): void {
    // 回合结束时删；没看到结束的（这条连接没订阅那个会话）不能一直攒着
    if (this.clientTurns.size >= ENDED_LIMIT) this.clientTurns.clear()
    this.clientTurns.add(`${harness}\u0000${turnId}`)
  }

  /** 这个回合是不是客户端带着用户的话发起的（不是唤醒、不是设备进程发的、不是引擎自己续跑的） */
  isUserTurn(harness: string, turnId: string): boolean {
    return this.clientTurns.has(`${harness}\u0000${turnId}`)
  }

  /** 会话现在有没有回合在跑（按看到的通知） */
  isActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  activeTurn(threadId: string): string | null {
    return this.active.get(threadId) ?? null
  }

  /** 回合结束时叫一声。返回取消 */
  onTurnEnded(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private engineEvent(harness: string, method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (method === 'turn/started' || method === 'turn/completed')
      this.turnEvent(harness, method, params)
    // 别处（官方桌面端等直连引擎的客户端）归档、删掉的，只能从引擎的通知上看到
    else if (method === 'thread/archived' && threadId) this.archived(threadId)
    else if (method === 'thread/deleted' && threadId) this.deleted(threadId)
    else if (method === 'serverRequest/resolved' && params.requestId != null)
      for (const [threadId, requests] of this.waiting) {
        requests.delete(String(params.requestId))
        if (requests.size === 0) this.waiting.delete(threadId)
      }
  }

  /** 设备进程的连接上收到一个要答复的请求（审批、提问）：不答，记下它在等用户 */
  private asked(params: Record<string, unknown>, id: unknown): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (!threadId || !this.store.parentOf(threadId)) return
    const requests = this.waiting.get(threadId) ?? new Map<string, number>()
    requests.set(String(id), Date.now())
    this.waiting.set(threadId, requests)
    this.later(this.host.needsUserMs + 10, () => this.stillWaiting(threadId))
  }

  /** 子会话的请求挂满了 needsUserMs：进一条“在等用户”的回报，看看能不能唤醒父会话 */
  private stillWaiting(threadId: string): void {
    const lineage = this.store.parentOf(threadId)
    const turnId = this.active.get(threadId) ?? ''
    if (!lineage || !this.waitingOnUser(threadId)) return
    const key = `${threadId}\u0000${turnId}`
    if (!this.askedOnce.has(key) && this.host.enabled()) {
      this.askedOnce.add(key)
      this.store.addNote(
        lineage.parentThreadId,
        { threadId, title: lineage.title, status: 'needsUser', excerpt: '' },
        lineage.wakeParent && !this.host.taskTurn(threadId, turnId),
      )
      this.notesChanged(lineage.parentThreadId)
    }
    this.check(lineage.parentThreadId)
  }

  /** 子会话里有挂满 needsUserMs、还没人答的请求 */
  waitingOnUser(threadId: string): boolean {
    const requests = this.waiting.get(threadId)
    if (!requests) return false
    const since = Math.min(...requests.values())
    return Date.now() - since >= this.host.needsUserMs
  }

  /** 一个回合开始或结束了（各条客户端连接的上游、设备进程自己的连接都会报，同一个回合会来好几次） */
  turnEvent(harness: string, method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    const turn = isObject(params.turn) ? params.turn : null
    if (!threadId || typeof turn?.id !== 'string') return
    const key = `${threadId}\u0000${turn.id}`
    if (this.ended.has(key)) return
    if (method === 'turn/started') {
      this.active.set(threadId, turn.id)
      return
    }
    if (this.ended.size >= ENDED_LIMIT) this.ended.clear()
    this.ended.add(key)
    if (this.active.get(threadId) === turn.id) this.active.delete(threadId)
    this.waiting.delete(threadId)
    const userDriven = this.clientTurns.delete(`${harness}\u0000${turn.id}`)
    const stop = this.userStops.get(threadId)
    this.userStops.delete(threadId)
    // 用户点了停止、回合却是自己先做完的，不算用户停的；归档的不管回合怎么结束都算
    const userStopped =
      stop === 'archived' || (stop === 'interrupted' && turn.status === 'interrupted')
        ? stop
        : undefined
    const wrapped = this.wrapped.delete(key)
    this.offersEnded(threadId, turn.id)
    this.noteRemind(threadId, turn, userDriven, wrapped)
    for (const listener of [...this.listeners]) listener(threadId)
    const lineage = this.store.parentOf(threadId)
    if (lineage && this.host.enabled() && this.store.markReported(threadId, turn.id))
      void this.report(
        harness,
        threadId,
        turn,
        !userDriven && !userStopped && !this.host.taskTurn(threadId, turn.id),
        userStopped,
      ).catch((error: unknown) =>
        this.host.log(`子会话 ${threadId} 的回报没取到：${String(error)}`),
      )
    // 父会话自己的回合结束了：它的子会话也许早就停了，看看要不要唤醒；有提醒、“在这里做”在等的，现在可以发了
    if (
      this.store.childrenOf(threadId).length ||
      this.reminders.has(threadId) ||
      this.heres.has(threadId)
    )
      this.check(threadId)
    this.releaseLater(harness, threadId)
  }

  // ---------- 提醒收尾 ----------

  /** 模型在这个回合里调了 litch_sessions.wrap_up（参数对）。还没发出去的提醒跟着作废 */
  wrappedUp(threadId: string, turnId: string): void {
    if (!turnId) return
    if (this.wrapped.size >= ENDED_LIMIT) this.wrapped.clear()
    this.wrapped.add(`${threadId}\u0000${turnId}`)
    this.reminders.delete(threadId)
  }

  /** 这个回合里已经调过收尾了没有 */
  isWrappedUp(threadId: string, turnId: string): boolean {
    return turnId !== '' && this.wrapped.has(`${threadId}\u0000${turnId}`)
  }

  /** 这个回合（连同它替之提醒的那个用户回合）里已经提了几张提案 */
  proposalsInTurn(threadId: string, turnId: string): number {
    const count = this.store.countInTurn(threadId, turnId)
    const origin = this.remindedFor.get(`${threadId}\u0000${turnId}`)
    return origin === undefined ? count : count + this.store.countInTurn(threadId, origin)
  }

  /** 这个回合是设备进程替它开的提醒回合 */
  isReminderTurn(threadId: string, turnId: string): boolean {
    return this.remindedFor.has(`${threadId}\u0000${turnId}`)
  }

  /**
   * 会话建的时候带的 litch_sessions 里有没有 wrap_up。建会话时按“每回合收尾”的开关定（currentSessionTools），
   * 之后改开关不影响已有的会话：工具是建会话时交给引擎的
   */
  hasWrapUp(threadId: string): boolean {
    const tools = this.store.tools(threadId) ?? []
    return tools.some(
      (spec) =>
        isObject(spec) &&
        spec.name === CLIENT_TOOL_NAMESPACE.sessions &&
        Array.isArray(spec.tools) &&
        spec.tools.some((tool) => isObject(tool) && tool.name === SESSION_TOOL.wrapUp),
    )
  }

  /**
   * 客户端建会话时带的 litch_sessions 换成设备进程按“每回合收尾”开关和这个 harness 的“任务卡”开关给的那份
   *（工具、说明、规则都跟着换）。没带 litch_sessions 的、不是数组的返回 null，照原样转
   */
  currentSessionTools(tools: unknown, harness: string): unknown[] | null {
    if (!Array.isArray(tools)) return null
    if (!tools.some((spec) => isObject(spec) && spec.name === CLIENT_TOOL_NAMESPACE.sessions))
      return null
    const wanted = sessionTools(this.host.wrapUp(), this.host.taskCards(harness))
    return tools.map((spec) =>
      isObject(spec) && spec.name === CLIENT_TOOL_NAMESPACE.sessions ? wanted : spec,
    )
  }

  /**
   * 这个会话会不会被提醒收尾：会话编排、每回合收尾、提醒都开着，会话建的时候带了 wrap_up。
   * 给了刚结束的回合时，它还得是正常结束的：出错、被截断、自动压缩失败的回合（引擎报成失败或带着错误）
   * 不提醒，提醒回合多半撞上同一个问题，白花一次请求的钱
   */
  private remindable(threadId: string, turn?: Record<string, unknown>): boolean {
    if (!this.host.enabled() || !this.host.wrapUp() || !this.host.wrapUpReminder()) return false
    if (turn && (turn.status !== 'completed' || turn.error)) return false
    return this.hasWrapUp(threadId)
  }

  /** 一个回合结束了：用户发起的、正常结束、没调 wrap_up 的，记下要提醒 */
  private noteRemind(
    threadId: string,
    turn: Record<string, unknown>,
    userDriven: boolean,
    wrapped: boolean,
  ): void {
    if (this.remindedFor.size >= ENDED_LIMIT) this.remindedFor.clear()
    if (!userDriven) return
    // 新的用户回合结束了：之前没发出去的提醒由这一回合的结果取代
    this.reminders.delete(threadId)
    if (!wrapped && this.remindable(threadId, turn)) this.reminders.set(threadId, String(turn.id))
  }

  /** 有提醒在等、会话闲着：替它开一个 kind=remind 的回合 */
  private async remind(threadId: string): Promise<void> {
    const origin = this.reminders.get(threadId)
    if (origin === undefined || this.closed) return
    if (!this.remindable(threadId)) {
      this.reminders.delete(threadId)
      return
    }
    // 还有回合在跑（唤醒回合、刚好又来的回合）：等它结束，turnEvent 会再查一遍
    if (!(await this.idle(threadId))) return
    const harness = await this.owner(threadId)
    // 这个 harness 的任务卡关了：建会话时带着 wrap_up 的也当场不再提醒
    if (!this.host.taskCards(harness)) {
      this.reminders.delete(threadId)
      return
    }
    await this.watch(harness, threadId)
    // 上面要等应答，这期间用户可能又说了话，或者别的回合里调了 wrap_up
    if (this.reminders.get(threadId) !== origin || this.active.has(threadId)) return
    this.reminders.delete(threadId)
    const link = await this.link(harness)
    const text = formatSessionEvent({ kind: 'remind', notes: [] })
    const result = await link.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    const turn = isObject(result) && isObject(result.turn) ? result.turn : null
    if (typeof turn?.id === 'string') {
      if (!this.active.has(threadId)) this.active.set(threadId, turn.id)
      this.remindedFor.set(`${threadId}\u0000${turn.id}`, origin)
    }
    this.host.log(`会话 ${threadId}（${harness}）的回合 ${origin} 没调收尾，开了一个提醒回合`)
  }

  /**
   * 子会话一回合结束：取最后一条回答的开头，失败、被打断的再带上回合的错误，进父会话的队列。
   * userStopped：用户亲手停下的（这时 wakeable 已经是假）
   */
  private async report(
    harness: string,
    threadId: string,
    turn: Record<string, unknown>,
    wakeable: boolean,
    userStopped?: SessionEventNote['userStopped'],
  ): Promise<void> {
    const lineage = this.store.parentOf(threadId)
    if (!lineage) return
    const status: SessionEventNote['status'] =
      turn.status === 'failed'
        ? 'failed'
        : turn.status === 'interrupted'
          ? 'interrupted'
          : 'completed'
    let answer = lastAnswer(turn)
    let error = status === 'completed' ? null : turnError(turn)
    if (answer === null || (status !== 'completed' && error === null)) {
      // 回合结束的通知里多半不带条目（有的也不带错误）：读一遍会话，找这个回合
      const { thread } = await this.read(threadId, true).catch(() => ({ thread: null }))
      const turns = isObject(thread) && Array.isArray(thread.turns) ? thread.turns : []
      const full = turns.find((one) => isObject(one) && one.id === turn.id)
      answer ??= lastAnswer(full)
      if (status !== 'completed') error ??= turnError(full)
    }
    // 回合刚结束、还在读的工夫里用户把它归档了（archived 那时还没有这条回报可改）：一样不唤醒
    if (!userStopped && this.host.index.archived(threadId) && !this.modelArchived.has(threadId)) {
      userStopped = 'archived'
      wakeable = false
    }
    // 决 430：有后台任务还在跑也照常算这一回合结束，回报里注明；后台跑完、引擎自己续跑的那一回合结束时再报一次
    const background = this.host.backgroundRunning(threadId)
    const note: SessionEventNote = {
      threadId,
      title: lineage.title,
      status,
      excerpt: (answer ?? '').slice(0, SESSION_TREE_LIMITS.noteChars),
      ...(background > 0 ? { backgroundTasks: background } : {}),
      ...(error ? { error: error.slice(0, SESSION_TREE_LIMITS.noteChars) } : {}),
      ...(userStopped ? { userStopped } : {}),
    }
    // 出错、被打断的回合不唤醒（同 Claude 桌面端：被截断的回合不算），等父会话下一回合带上，
    // 或者别的子会话的回报唤醒父会话时一起交出去。父会话正在跑的话不分结局都当场插进去（check 里的 steerNotes）
    this.store.addNote(
      lineage.parentThreadId,
      note,
      lineage.wakeParent && wakeable && status === 'completed',
    )
    this.notesChanged(lineage.parentThreadId)
    this.host.log(`子会话 ${threadId}（${harness}）的回合 ${String(turn.id)} 已进父会话的回报队列`)
    if (background > 0) {
      const running = this.host
        .backgroundTasks(threadId)
        .filter((task) => task.status === 'running')
        .map((task) => task.id)
      this.backgroundOwed.set(threadId, { tasks: new Set(running), byUser: false })
      // 跑完以后的事（自发回合、集合变化）要看得到：盯上这个子会话
      void this.watch(harness, threadId).catch((error: unknown) =>
        this.host.log(`盯子会话 ${threadId} 的后台任务没成：${String(error)}`),
      )
    } else this.backgroundOwed.delete(threadId)
    this.check(lineage.parentThreadId)
  }

  /** 用户在后台任务页上停了这个会话的命令（客户端的 thread/backgroundTerminals/terminate、clean） */
  backgroundStopped(threadId: string): void {
    const owed = this.backgroundOwed.get(threadId)
    if (owed) owed.byUser = true
  }

  /**
   * 子会话的后台任务全部结束了（background.mts 的 onSettled）。引擎会自己接着做、也真有任务是自己跑完的，
   * 等那一回合结束照常回报；不会接着做的（原生 codex），或者一个都不是自己跑完的（都被停了，引擎不续跑），
   * 这里补一条回报，摘录写各任务的结局。全是用户停的（决 481）：写明是用户停的，只进队列、不唤醒父会话
   */
  backgroundSettled(threadId: string, tasks: LitchBackgroundTask[]): void {
    const owed = this.backgroundOwed.get(threadId)
    if (!owed) return
    const ended = tasks.filter((task) => owed.tasks.has(task.id) && task.status !== 'running')
    const finished = ended.some((task) => task.status === 'completed' || task.status === 'failed')
    if (finished && this.host.backgroundWakes(threadId)) return
    this.backgroundOwed.delete(threadId)
    const lineage = this.store.parentOf(threadId)
    if (!lineage || !this.host.enabled()) return
    const byUser = owed.byUser && ended.some((task) => task.status === 'stopped')
    const outcome = (task: LitchBackgroundTask) =>
      task.status === 'stopped' && byUser ? 'stopped by the user' : task.status
    const outcomes = (ended.length ? ended : tasks.filter((task) => task.status !== 'running'))
      .slice(0, 5)
      .map((task) => `${task.title} (${outcome(task)})`)
      .join('; ')
    const note: SessionEventNote = {
      threadId,
      title: lineage.title,
      status: 'completed',
      excerpt: `Background tasks finished: ${outcomes}`.slice(0, SESSION_TREE_LIMITS.noteChars),
    }
    const allByUser = byUser && !finished
    this.store.addNote(lineage.parentThreadId, note, lineage.wakeParent && !allByUser)
    this.notesChanged(lineage.parentThreadId)
    this.host.log(`子会话 ${threadId} 的后台任务跑完了，补了一条回报`)
    this.check(lineage.parentThreadId)
  }

  // ---------- 唤醒 ----------

  /**
   * 看看要不要把回报插进在跑的回合、发“在这里做”、提醒收尾、唤醒这个会话。同一个会话的检查排成一条，检查途中又来的再查一遍。
   * 会话在跑时只有插话这一样做得了；停着时先发用户点出来的那句话（它是用户的话，提醒跟着作废、回报跟着交出去），
   * 再提醒，最后唤醒：前一样开出回合之后会话就不闲了，后面的等它结束（turnEvent 再查）
   */
  check(parentId: string): void {
    const previous = this.checks.get(parentId) ?? Promise.resolve()
    const next = previous
      .then(() =>
        this.steerNotes(parentId).catch((error: unknown) =>
          this.host.log(`往 ${parentId} 在跑的回合里插回报没成：${String(error)}`),
        ),
      )
      .then(() =>
        this.sendHere(parentId).catch((error: unknown) =>
          this.host.log(`往 ${parentId} 发“在这里做”没成：${String(error)}`),
        ),
      )
      .then(() =>
        this.remind(parentId).catch((error: unknown) =>
          this.host.log(`提醒 ${parentId} 收尾没成：${String(error)}`),
        ),
      )
      .then(() => this.wake(parentId))
      .catch((error: unknown) => this.host.log(`唤醒 ${parentId} 没成：${String(error)}`))
      .finally(() => {
        if (this.checks.get(parentId) === next) this.checks.delete(parentId)
      })
    this.checks.set(parentId, next)
  }

  /** 全部有回报在排队的父会话都查一遍（有客户端连上来时） */
  checkAll(): void {
    for (const parentId of this.store.noteParents()) this.check(parentId)
  }

  /**
   * 父会话有回合在跑：把排着的回报（每个子会话最新一条，合成一段）当场插进这个回合（turn/steer），
   * 模型在同一回合里就看到，不用等回合结束、也不多开回合（同 Claude 桌面端）。出错、被打断的也插：插话不开回合，没有唤醒的代价。
   * 插成了从队列里拿掉，界面上它是回合里一条只有回报的用户消息（核心认出 <litch-session-event>，画成“子会话的回报”）；
   * 回合正好在收尾、引擎不会插话的，留在队列里照旧等下一回合或唤醒
   */
  private async steerNotes(parentId: string): Promise<void> {
    if (this.closed || !this.host.enabled()) return
    const running = this.active.get(parentId)
    if (running === undefined || this.store.notes(parentId).length === 0) return
    const harness = await this.owner(parentId)
    if (this.noSteer.has(harness)) return
    // 设备进程的连接要订阅着它才插得进（有的引擎只认装着这个会话的连接），回合结束时 turnEvent 退订
    await this.watch(harness, parentId)
    const notes = this.store.notes(parentId)
    if (notes.length === 0 || this.active.get(parentId) !== running) return
    const link = await this.link(harness)
    const latest = latestPerSession(notes)
    const text = formatSessionEvent({ kind: 'notes', notes: latest.map(publicNote) })
    try {
      await link.request('turn/steer', {
        threadId: parentId,
        expectedTurnId: running,
        clientUserMessageId: `litch-sessions-${this.runMark}-${++this.steerSeq}`,
        input: [{ type: 'text', text, text_elements: [] }],
      })
    } catch (error) {
      if (error instanceof UpstreamRpcError && error.code === -32601) this.noSteer.add(harness)
      this.host.log(
        `回报没插进 ${parentId}（${harness}）在跑的回合，留着等下一回合：${String(error)}`,
      )
      return
    }
    this.store.dropNotes(parentId, Math.max(...notes.map((note) => note.seq)))
    this.notesChanged(parentId)
    this.host.log(`把 ${latest.length} 条回报插进了 ${parentId}（${harness}）在跑的回合 ${running}`)
  }

  private async wake(parentId: string): Promise<void> {
    if (this.closed || !this.host.enabled() || this.host.clients() === 0) return
    const notes = this.store.notes(parentId)
    if (!notes.some((note) => note.wake)) return
    if (this.store.wakes(parentId) >= SESSION_TREE_LIMITS.wakesPerUserMessage) return
    // 子会话都停下了（在等用户答的挂满一阵也算），父会话自己闲着（等着用户答请求的也是在跑）
    for (const child of this.store.childrenOf(parentId)) {
      if (this.waitingOnUser(child.threadId)) continue
      if (!(await this.idle(child.threadId))) return
    }
    if (!(await this.idle(parentId))) return
    const harness = await this.owner(parentId)
    await this.watch(harness, parentId)
    // 上面那几步要等应答，这期间可能有用户发了话（回报已经跟着交出去了）
    const fresh = this.store.notes(parentId)
    if (!fresh.some((note) => note.wake) || this.active.has(parentId)) return
    const link = await this.link(harness)
    const latest = latestPerSession(fresh)
    const text = formatSessionEvent({ kind: 'wake', notes: latest.map(publicNote) })
    const result = await link.request('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    const turn = isObject(result) && isObject(result.turn) ? result.turn : null
    if (typeof turn?.id === 'string' && !this.active.has(parentId))
      this.active.set(parentId, turn.id)
    this.store.dropNotes(parentId, Math.max(...fresh.map((note) => note.seq)))
    this.notesChanged(parentId)
    this.store.setWakes(parentId, this.store.wakes(parentId) + 1)
    this.host.log(`替会话 ${parentId}（${harness}）开了一个唤醒回合，带着 ${latest.length} 条回报`)
  }

  /**
   * 会话停着没有。看到的通知和引擎说的都要是停着；引擎说停着、通知还记着在跑的，是漏了结束的通知
   * （设备进程的连接断过、重启过），以引擎为准。读不到的只看通知
   */
  private async idle(threadId: string): Promise<boolean> {
    const before = this.active.get(threadId)
    const { thread } = await this.read(threadId, false).catch(() => ({ thread: null }))
    if (thread === null) return before === undefined
    if (busy(thread)) return false
    if (before !== undefined && this.active.get(threadId) === before) this.active.delete(threadId)
    return !this.active.has(threadId)
  }

  /**
   * 客户端要给一个会话发起回合（turn/start）：这是用户的一句话。唤醒计数清零；有回报在排队的话，
   * 包成 kind=notes 的一段放在用户消息前面一起交给引擎，返回新的输入。没有要附的返回 null。
   */
  beforeUserTurn(threadId: string, input: unknown): unknown[] | null {
    this.userSpoke(threadId)
    if (this.store.wakes(threadId) > 0) this.store.setWakes(threadId, 0)
    // 用户又说话了：上一回合没发出去的提醒不用了，这一回合结束时再看
    this.reminders.delete(threadId)
    if (!this.host.enabled() || !Array.isArray(input)) return null
    const notes = this.store.notes(threadId)
    if (notes.length === 0) return null
    this.store.dropNotes(threadId, Math.max(...notes.map((note) => note.seq)))
    this.notesChanged(threadId)
    const event = formatSessionEvent({
      kind: 'notes',
      notes: latestPerSession(notes).map(publicNote),
    })
    const at = input.findIndex((item) => isObject(item) && item.type === 'text')
    if (at < 0) return [{ type: 'text', text: event, text_elements: [] }, ...input]
    const first = input[at] as Record<string, unknown>
    const original = typeof first.text === 'string' ? first.text : ''
    // 用户的话前面多了一段，原来按字节位置标的元素（@ 提及等）跟着往后挪
    const shift = Buffer.byteLength(`${event}\n`)
    const elements = Array.isArray(first.text_elements)
      ? first.text_elements.map((element) => shifted(element, shift))
      : first.text_elements
    const merged = {
      ...first,
      text: `${event}\n${original}`,
      ...(elements === undefined ? {} : { text_elements: elements }),
    }
    return input.map((item, index) => (index === at ? merged : item))
  }

  // ---------- 会话对象、父子关系 ----------

  /**
   * 会话对象经过聚合面、发给声明了 sessionTree 的连接时：有父会话的挂上 litchLineage；
   * 记着建会话时带的动态工具的，挂上其中 litch_ 开头的命名空间（litchToolNamespaces）
   */
  decorate(thread: Record<string, unknown>): void {
    if (typeof thread.id !== 'string') return
    const lineage = this.lineage(thread.id)
    if (lineage) thread.litchLineage = lineage
    const queued = this.queuedNotes(thread.id)
    if (queued.length) thread.litchQueuedNotes = queued
    const tools = this.store.tools(thread.id)
    if (tools) {
      thread.litchToolNamespaces = tools.flatMap((spec) =>
        isObject(spec) &&
        spec.type === 'namespace' &&
        typeof spec.name === 'string' &&
        spec.name.startsWith('litch_')
          ? [spec.name]
          : [],
      )
    }
  }

  /** 会话对外的 litchLineage。没有父会话（或者脱离了）是 null */
  lineage(threadId: string): SessionLineage | null {
    const row = this.store.parentOf(threadId)
    if (!row) return null
    return {
      parentThreadId: row.parentThreadId,
      kind: row.kind,
      origin: row.origin,
      title: row.title,
      wakeParent: row.wakeParent,
      createdAt: row.createdAt,
      ...(row.proposalId ? { proposalId: row.proposalId } : {}),
    }
  }

  /** 父子关系变了：告诉声明了 sessionTree 的连接 */
  lineageChanged(threadId: string): void {
    this.host.announce(
      SESSION_TREE_NOTIFICATION.lineageUpdated,
      { threadId, lineage: this.lineage(threadId) },
      EXTENSION.sessionTree,
    )
  }

  /** 这个会话现在排着、还没交给模型的回报：每个子会话最新的一条，次序同交出去时 */
  queuedNotes(threadId: string): SessionQueuedNote[] {
    return latestPerSession(this.store.notes(threadId)).map((note) => ({
      ...publicNote(note),
      at: note.at,
    }))
  }

  /** 回报队列变了：告诉声明了 sessionTree 的连接，父会话的对话区当场画出来 */
  private notesChanged(threadId: string): void {
    this.host.announce(
      SESSION_TREE_NOTIFICATION.queuedNotesUpdated,
      { threadId, notes: this.queuedNotes(threadId) },
      EXTENSION.sessionTree,
    )
  }

  /** 脱离成独立会话 */
  detach(threadId: string): void {
    if (!this.store.detach(threadId))
      throw new DeviceError('unknownThread', `会话 ${threadId} 不是谁的子会话`, { threadId })
    this.lineageChanged(threadId)
  }

  // ---------- 提案 ----------

  /** 正在开始的提案（用户点了“开始”、模型调了 accept）：同一个提案只起一个，撤回、不要要等它起完 */
  readonly accepting = new Map<string, Promise<{ threadId: string; harness: string }>>()

  propose(
    fields: Omit<
      SessionProposal,
      'id' | 'status' | 'createdAt' | 'expiresAt' | 'startedThreadId' | 'settledAt'
    >,
  ): SessionProposal {
    const createdAt = now()
    const proposal = this.store.addProposal({
      ...fields,
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + SESSION_TREE_LIMITS.proposalTtlSeconds,
    })
    this.proposalsChanged(fields.threadId, [proposal])
    this.scheduleExpiry()
    return proposal
  }

  /**
   * 一个会话上的提案（先把到期的收掉）。缺省只给 pending 的、先提的在前；
   * includeSettled 时连了结的一起，新的在前，最多 proposalListMax 条
   */
  proposals(threadId: string, includeSettled = false): SessionProposal[] {
    this.expire()
    return includeSettled
      ? this.store.recent(threadId, SESSION_TREE_LIMITS.proposalListMax)
      : this.store.pending(threadId)
  }

  /** 拿一个提案（先把到期的收掉）。没有是 null */
  proposal(proposalId: string): SessionProposal | null {
    this.expire()
    return this.store.proposal(proposalId)
  }

  /**
   * 拿一个状态是 status 的提案（缺省 pending；模型给 offer 卡补简报开始时是 chosen）。
   * 没有、状态不对（已经开始、不要了、撤回了、过期了……）都抛错
   */
  pendingProposal(proposalId: string, status: Status = 'pending'): SessionProposal {
    const proposal = this.proposal(proposalId)
    if (!proposal) throw new DeviceError('unsupported', `没有提案 ${proposalId}`)
    if (proposal.status !== status)
      throw new DeviceError('unsupported', `提案 ${proposalId} ${STATUS_WORD[proposal.status]}`)
    return proposal
  }

  /** 把提案从 from（缺省 pending）里的状态改成 status，通知声明过的连接。已经不在 from 里了返回 null */
  settleProposal(
    proposalId: string,
    status: Status,
    threadId: string | null,
    from: readonly Status[] = ['pending'],
  ): SessionProposal | null {
    if (!this.store.moveProposal(proposalId, from, status, threadId)) return null
    const settled = this.store.proposal(proposalId)
    if (settled) this.proposalsChanged(settled.threadId, [settled])
    return settled
  }

  /**
   * 普通提案卡上用户点了“在这里做”（litch/sessionProposal/here）：只收 pending 的，提案记 here，往父会话发一条用户消息
   *（lead 加标题，空一行再是任务原文，不带背景）。父会话闲着当场发，在跑就排到回合结束后（check 里先发它）；
   * 设备进程关掉时还没发出的丢掉，提案仍是 here。send 为 false（litch/sessionProposal/markHere）时只了结、
   * 不发，那句话交回给客户端自己排进输入队列。返回那句话
   */
  proposalHere(proposalId: string, lead?: string, send = true): string {
    // markHere 的应答丢了（超时）客户端会再问一遍：已经由 markHere 了结的回同一句话
    const marked = send ? undefined : this.marked.get(proposalId)
    if (marked !== undefined) return marked
    if (this.accepting.has(proposalId))
      throw new DeviceError('unsupported', `提案 ${proposalId} 正在开始`)
    const proposal = this.pendingProposal(proposalId)
    if (!this.settleProposal(proposalId, 'here', null, ['pending']))
      throw new DeviceError('unsupported', `提案 ${proposalId} 已经了结了`)
    const text = `${lead ?? 'Do it here: '}${proposal.title}\n\n${proposal.prompt}`
    if (!send) {
      this.marked.set(proposalId, text)
      return text
    }
    this.heres.set(proposal.threadId, [...(this.heres.get(proposal.threadId) ?? []), text])
    this.check(proposal.threadId)
    return text
  }

  /**
   * 会话闲着、有“在这里做”在排队：发最早的那条，当作用户说的一句话（同客户端的 turn/start：攒着的回报放在前面，
   * 唤醒计数清零、没发的提醒作废；这个回合算用户发起的，能直接派子会话、会被提醒收尾）。发不出去的留着，下次再试
   */
  private async sendHere(threadId: string): Promise<void> {
    const text = this.heres.get(threadId)?.[0]
    if (text === undefined || this.closed) return
    if (!(await this.idle(threadId))) return
    const harness = await this.owner(threadId)
    await this.watch(harness, threadId)
    if (this.active.has(threadId) || this.heres.get(threadId)?.[0] !== text) return
    const said = [{ type: 'text', text, text_elements: [] }]
    const input = this.beforeUserTurn(threadId, said) ?? said
    const link = await this.link(harness)
    const result = await link.request('turn/start', { threadId, input })
    const queued = this.heres.get(threadId) ?? []
    queued.shift()
    if (queued.length === 0) this.heres.delete(threadId)
    const turn = isObject(result) && isObject(result.turn) ? result.turn : null
    if (typeof turn?.id === 'string') {
      if (!this.active.has(threadId)) this.active.set(threadId, turn.id)
      this.clientTurn(harness, turn.id)
    }
    this.host.log(`替会话 ${threadId}（${harness}）发了提案卡上点的“在这里做”`)
  }

  // ---------- offer 卡 ----------

  /**
   * 等一张刚落下的 offer 卡（offered）了结。signal 作废（回合结束、设备进程要关）时当作在这里做；
   * 设备进程在关的时候不再改库，重启时统一了结（构造函数）
   */
  waitOffer(proposal: SessionProposal, signal: AbortSignal): Promise<OfferOutcome> {
    return new Promise((resolve) => {
      const aborted = () => this.offerHere(proposal.id, 'ended')
      this.offers.set(proposal.id, {
        threadId: proposal.threadId,
        turnId: proposal.turnId ?? '',
        resolve: (outcome) => {
          signal.removeEventListener('abort', aborted)
          resolve(outcome)
        },
      })
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
  }

  /**
   * 用户在 offer 卡上选了（litch/sessionProposal/answer）：session 改成 chosen（等模型补简报），here 了结成 here，
   * 在等的那次调用拿到选择。不是 offer 卡、已经选过（或者别的原因了结了）的抛错
   */
  answerOffer(proposalId: string, choice: 'session' | 'here', worktree?: boolean): void {
    const proposal = this.proposal(proposalId)
    if (!proposal) throw new DeviceError('unsupported', `没有提案 ${proposalId}`)
    if (!proposal.offer)
      throw new DeviceError('unsupported', `提案 ${proposalId} 不是“新会话 / 在这里做”的卡`)
    if (proposal.status !== 'offered')
      throw new DeviceError('unsupported', `提案 ${proposalId} ${STATUS_WORD[proposal.status]}`)
    const wait = this.offers.get(proposalId)
    if (!wait) {
      // 等它的那次调用已经不在了（按说不会：落卡和开始等是同一步）。当作在这里做了结，免得卡一直挂着
      this.settleProposal(proposalId, 'here', null, ['offered'])
      throw new DeviceError('unsupported', `提案 ${proposalId} 那次调用已经结束了`)
    }
    const status = choice === 'session' ? 'chosen' : 'here'
    // 卡上的工作树开关：模型补简报开起来时照它
    if (choice === 'session' && worktree !== undefined)
      this.store.setProposalWorktree(proposalId, worktree)
    if (!this.settleProposal(proposalId, status, null, ['offered']))
      throw new DeviceError('unsupported', `提案 ${proposalId} 已经了结了`)
    this.offers.delete(proposalId)
    wait.resolve({ choice, reason: 'answered' })
  }

  /**
   * 选了新会话的 offer 卡（chosen），模型补的简报要开到收不紧沙箱的 harness 上：不开，降成一张带简报的普通提案
   *（pending、带 widerSandbox，offer 仍为真），用户在卡上看过再决定开不开。已经不是 chosen 了（回合结束当作在这里做了）返回 null
   */
  holdOffer(
    proposalId: string,
    brief: Pick<
      SessionProposal,
      'title' | 'prompt' | 'background' | 'harness' | 'model' | 'effort' | 'cwd' | 'kind'
    > & { widerSandbox: string },
  ): SessionProposal | null {
    const expiresAt = now() + SESSION_TREE_LIMITS.proposalTtlSeconds
    if (!this.store.holdOffer(proposalId, { ...brief, expiresAt })) return null
    const held = this.store.proposal(proposalId)
    if (!held) return null
    this.proposalsChanged(held.threadId, [held])
    this.scheduleExpiry()
    return held
  }

  /** 一张在等的 offer 卡不等了：当作在这里做（还没选的才改库），在等的那次调用拿到 here */
  private offerHere(proposalId: string, reason: OfferOutcome['reason']): void {
    const wait = this.offers.get(proposalId)
    if (!wait) return
    this.offers.delete(proposalId)
    if (!this.closed) this.settleProposal(proposalId, 'here', null, ['offered'])
    wait.resolve({ choice: 'here', reason })
  }

  /** 用户在这个会话里又发了话（turn/start、turn/steer）：在等的 offer 卡当作在这里做 */
  userSpoke(threadId: string): void {
    for (const [id, wait] of [...this.offers])
      if (wait.threadId === threadId) this.offerHere(id, 'spoke')
  }

  /**
   * 用户打断了这个会话的回合（客户端的 turn/interrupt）：在等的 offer 卡当作在这里做；
   * 是子会话、正在跑的话记下是用户停的
   */
  interrupted(threadId: string): void {
    for (const [id, wait] of [...this.offers])
      if (wait.threadId === threadId) this.offerHere(id, 'interrupted')
    if (this.store.parentOf(threadId) && this.active.has(threadId))
      this.userStops.set(threadId, 'interrupted')
  }

  /**
   * 子会话被归档了（客户端发的 thread/archive，或引擎的 thread/archived 通知）：用户不要它了。
   * 在跑的回合结束时的回报、已经排着的回报都不再唤醒父会话，注明已归档
   */
  archived(threadId: string): void {
    const lineage = this.store.parentOf(threadId)
    if (!lineage || this.modelArchived.has(threadId)) return
    if (this.active.has(threadId)) this.userStops.set(threadId, 'archived')
    this.store.muteNotes(threadId, 'archived')
    this.notesChanged(lineage.parentThreadId)
  }

  /** 会话删掉了：它带的动态工具、记下的速度跟着删 */
  deleted(threadId: string): void {
    this.store.dropTools(threadId)
    this.store.setSpeed(threadId, null)
  }

  /**
   * 一个回合结束了：这一回合里还在等用户选的 offer 卡当作在这里做；用户选了新会话、模型到回合结束都没补简报开起来的
   * （chosen，正在开始的除外）也当作在这里做
   */
  private offersEnded(threadId: string, turnId: string): void {
    for (const [id, wait] of [...this.offers])
      if (wait.threadId === threadId && wait.turnId === turnId) this.offerHere(id, 'ended')
    for (const proposal of this.store.pending(threadId))
      if (
        proposal.status === 'chosen' &&
        proposal.turnId === turnId &&
        !this.accepting.has(proposal.id)
      )
        this.settleProposal(proposal.id, 'here', null, ['chosen'])
  }

  /** 提案变了：带上这个会话现在全部 pending 的，和刚变的那几条 */
  private proposalsChanged(threadId: string, changed: SessionProposal[]): void {
    this.host.announce(
      SESSION_TREE_NOTIFICATION.proposalChanged,
      { threadId, proposals: this.store.pending(threadId), changed },
      EXTENSION.sessionTree,
    )
  }

  /** 到期的提案收掉，按会话各通知一次 */
  private expire(): void {
    const touched = new Map<string, SessionProposal[]>()
    for (const proposal of this.store.expiring(now())) {
      if (!this.store.settleProposal(proposal.id, 'expired', null)) continue
      const settled = this.store.proposal(proposal.id) ?? proposal
      touched.set(proposal.threadId, [...(touched.get(proposal.threadId) ?? []), settled])
    }
    for (const [threadId, changed] of touched) this.proposalsChanged(threadId, changed)
  }

  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    const at = this.store.nextExpiry()
    if (at === null || this.closed) return
    // 定时器最多等 24 天多一点，到期还远的先等一阵再看
    const ms = Math.min(Math.max(0, at * 1000 - Date.now()) + 50, 2_000_000_000)
    this.expiry = setTimeout(() => {
      this.expiry = null
      this.expire()
      this.scheduleExpiry()
    }, ms)
    this.expiry.unref()
  }

  // ---------- 客户端来去、收尾 ----------

  /** 一条客户端连接握手完成：攒着的唤醒现在可以做了；设备进程重启后第一次还要把在跑的子会话重新盯上 */
  clientJoined(): void {
    if (!this.recovered) {
      this.recovered = true
      void this.recover()
    }
    this.checkAll()
  }

  /**
   * 设备进程重启过：上一次在跑的子会话重新订阅（不然收不到它们的回合结束），停着的看看最后一个回合报过没有。
   * 只看最近派的这些，旧的子会话早就报完了
   */
  private async recover(harness?: string): Promise<void> {
    const recent = this.store
      .children()
      .filter((child) => harness === undefined || child.harness === harness)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
    for (const child of recent) {
      try {
        const { harness, thread } = await this.read(child.threadId, true)
        if (busy(thread)) {
          await this.watch(harness, child.threadId)
          continue
        }
        const turns = Array.isArray(thread.turns) ? thread.turns : []
        const last = turns.at(-1)
        if (isObject(last) && typeof last.id === 'string' && last.status !== 'inProgress')
          this.turnEvent(harness, 'turn/completed', { threadId: child.threadId, turn: last })
      } catch (error) {
        this.host.log(`重新盯子会话 ${child.threadId} 没成：${String(error)}`)
      }
    }
  }

  /** 到这个 harness 的连接断了：隔一阵重开、把它上面的子会话重新盯上。运行时一时起不来就再等等，几次之后放弃 */
  private rewatch(harness: string, attempt: number): void {
    if (
      attempt >= REWATCH_MS.length ||
      this.store.children().every((child) => child.harness !== harness)
    )
      return
    this.later(REWATCH_MS[attempt] as number, () => {
      this.link(harness).then(
        () => this.recover(harness),
        () => this.rewatch(harness, attempt + 1),
      )
    })
  }

  close(): void {
    this.closed = true
    if (this.expiry) clearTimeout(this.expiry)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.releasing.values()) clearTimeout(timer)
    this.releasing.clear()
    for (const pending of this.links.values())
      void pending.then(
        (link) => link.close(),
        () => {},
      )
    this.links.clear()
  }

  private later(ms: number, work: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) work()
    }, ms)
    timer.unref()
    this.timers.add(timer)
  }
}

type Status = SessionProposal['status']

/** 提案状态不对时的说明（接在“提案 xxx ”后面） */
const STATUS_WORD: Record<Status, string> = {
  pending: '还在等用户点',
  offered: '还在等用户选新会话还是在这里做',
  chosen: '用户已经选了新会话、在等模型补简报',
  here: '已经当作在这里做了结了',
  started: '已经开始了',
  dismissed: '已经被用户拒绝了',
  withdrawn: '已经撤回了',
  expired: '已经过期了',
}

/** 会话对象上的状态说它有回合在跑（等着用户答请求也算在跑） */
function busy(thread: unknown): boolean {
  const status = isObject(thread) && isObject(thread.status) ? thread.status : null
  return status?.type === 'active'
}

/** 队列里的回报去掉库里才有的字段 */
/**
 * 同一个子会话排了几条回报（父会话忙着的时候它又跑了几回合）只交最新的一条：旧的失败、半截的结果已经过时，
 * 列在一起像是前后矛盾。次序按各子会话最新那条进队列的先后
 */
function latestPerSession<T extends SessionEventNote & { seq: number }>(notes: T[]): T[] {
  const latest = new Map<string, T>()
  for (const note of [...notes].sort((a, b) => a.seq - b.seq)) {
    latest.delete(note.threadId)
    latest.set(note.threadId, note)
  }
  return [...latest.values()]
}

function publicNote(note: SessionEventNote): SessionEventNote {
  return {
    threadId: note.threadId,
    title: note.title,
    status: note.status,
    excerpt: note.excerpt,
    ...(note.backgroundTasks ? { backgroundTasks: note.backgroundTasks } : {}),
    ...(note.error ? { error: note.error } : {}),
    ...(note.userStopped ? { userStopped: note.userStopped } : {}),
  }
}

/** 回合上的错误原文（turn.error.message）。没有是 null */
function turnError(turn: unknown): string | null {
  const error = isObject(turn) && isObject(turn.error) ? turn.error : null
  return typeof error?.message === 'string' && error.message.trim() ? error.message : null
}

/** 用户消息里标出来的一个元素（按 UTF-8 字节位置），整体往后挪 shift 个字节 */
function shifted(element: unknown, shift: number): unknown {
  if (!isObject(element) || !isObject(element.byteRange)) return element
  const range = element.byteRange
  const start = typeof range.start === 'number' ? range.start + shift : range.start
  const end = typeof range.end === 'number' ? range.end + shift : range.end
  return { ...element, byteRange: { ...range, start, end } }
}
