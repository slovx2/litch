// 会话树（sessionTree 扩展，protocol/extensions/session-tree.json）在设备进程里的主体：
// 父子关系、提案、回报队列、唤醒。派子会话的做法在 session-start.mts，模型用的 litch_sessions 在 session-tools.mts。
//
// 设备进程自己对每个 harness 开一条引擎连接（engine-link.mts，按需开、断了下次再开），用它建子会话、发回合、
// 读会话，并订阅它建的子会话：子会话一回合结束，哪怕没有客户端开着它，设备进程也收得到。
// 回合的开始与结束还从各条客户端连接的上游上看（relay.mts 调 turnEvent），两边按回合号去重。
//
// 回报：子会话一回合结束，取最后一条回答前 400 字进父会话的队列（sessions.sqlite），父会话下一个由客户端发起的
// 回合把它们包成 kind=notes 的一段放在用户消息前面（beforeUserTurn）。
// 唤醒：有客户端连着、开关开着、父会话闲着、它没脱离的直接子会话都停下了（在等用户答的挂满 needsUserMs 也算停下）、
// 队列里有该唤醒的回报、上一条用户消息之后唤醒不到 10 次，设备进程替父会话发一个 kind=wake 的回合。
import { randomUUID } from 'node:crypto'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  formatSessionEvent,
  SESSION_TREE_LIMITS,
  SESSION_TREE_NOTIFICATION,
  type SessionEventNote,
  type SessionLineage,
  type SessionProposal,
} from '../../protocol/src/session-tree.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { HarnessSource } from './session.mjs'
import type { SessionStore } from './session-store.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { DeviceError, isObject } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

export interface SessionTreeHost {
  harnesses(): HarnessSource[]
  openEngineLink(harness: string): Promise<EngineLink>
  index: ThreadIndex
  workspaces: Workspaces
  store: SessionStore
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
  /** 这个回合是定时任务发起的：只进回报，不唤醒父会话 */
  taskTurn(threadId: string, turnId: string): boolean
  log(line: string): void
}

/** 会话对象上的一段文字，掐成 limit 个字以内：留头留尾，中间换成省略号 */
export function trimText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const head = Math.ceil((limit - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (limit - 1 - head))}`
}

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

export class SessionTree {
  readonly host: SessionTreeHost
  private readonly links = new Map<string, Promise<EngineLink>>()
  /** 每条引擎连接订阅了哪些会话 */
  private readonly subscribed = new Map<string, Set<string>>()
  /** 在跑的回合：会话 → 回合 */
  private readonly active = new Map<string, string>()
  /** 客户端用 turn/start 发起的回合（harness + 回合）：只有它们算用户发起的 */
  private readonly clientTurns = new Set<string>()
  /** 子会话里挂着没人答的请求：会话 → 请求号 → 开始挂的时刻（毫秒） */
  private readonly waiting = new Map<string, Map<string, number>>()
  /** 已经为“在等用户”进过一次队列的回合，同一个回合只报一次 */
  private readonly askedOnce = new Set<string>()
  /**
   * 已经结束的回合（会话 + 回合）。同一个回合的通知从好几条连接各来一份，各走各的套接字：
   * 一条连接上的“开始”可能排在另一条连接上的“结束”后面到，认出来的就不再当它在跑
   */
  private readonly ended = new Set<string>()
  /** 回合结束时要叫醒的（wait 工具在等） */
  private readonly listeners = new Set<(threadId: string) => void>()
  /** 每个父会话的唤醒检查排成一条，免得一次结束触发两个唤醒 */
  private readonly checks = new Map<string, Promise<void>>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private expiry: NodeJS.Timeout | null = null
  private recovered = false
  private closed = false

  constructor(host: SessionTreeHost) {
    this.host = host
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
    const link = await this.link(harness)
    if (this.subscribed.get(harness)?.has(threadId)) return null
    const result = await link.request('thread/resume', { threadId })
    this.noteSubscribed(harness, threadId)
    return isObject(result) ? result : null
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
    if (method === 'turn/started' || method === 'turn/completed')
      this.turnEvent(harness, method, params)
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
    for (const listener of [...this.listeners]) listener(threadId)
    const lineage = this.store.parentOf(threadId)
    if (lineage && this.host.enabled() && this.store.markReported(threadId, turn.id))
      void this.report(
        harness,
        threadId,
        turn,
        !userDriven && !this.host.taskTurn(threadId, turn.id),
      ).catch((error: unknown) =>
        this.host.log(`子会话 ${threadId} 的回报没取到：${String(error)}`),
      )
    // 父会话自己的回合结束了：它的子会话也许早就停了，看看要不要唤醒
    if (this.store.childrenOf(threadId).length) this.check(threadId)
  }

  /** 子会话一回合结束：取最后一条回答的开头，进父会话的队列 */
  private async report(
    harness: string,
    threadId: string,
    turn: Record<string, unknown>,
    wakeable: boolean,
  ): Promise<void> {
    const lineage = this.store.parentOf(threadId)
    if (!lineage) return
    let answer = lastAnswer(turn)
    if (answer === null) {
      // 回合结束的通知里多半不带条目：读一遍会话，找这个回合
      const { thread } = await this.read(threadId, true).catch(() => ({ thread: null }))
      const turns = isObject(thread) && Array.isArray(thread.turns) ? thread.turns : []
      answer = lastAnswer(turns.find((one) => isObject(one) && one.id === turn.id))
    }
    const status: SessionEventNote['status'] =
      turn.status === 'failed'
        ? 'failed'
        : turn.status === 'interrupted'
          ? 'interrupted'
          : 'completed'
    const note: SessionEventNote = {
      threadId,
      title: lineage.title,
      status,
      excerpt: (answer ?? '').slice(0, SESSION_TREE_LIMITS.noteChars),
    }
    this.store.addNote(lineage.parentThreadId, note, lineage.wakeParent && wakeable)
    this.host.log(`子会话 ${threadId}（${harness}）的回合 ${String(turn.id)} 已进父会话的回报队列`)
    this.check(lineage.parentThreadId)
  }

  // ---------- 唤醒 ----------

  /** 看看要不要唤醒这个父会话。同一个父会话的检查排成一条，检查途中又来的再查一遍 */
  check(parentId: string): void {
    const previous = this.checks.get(parentId) ?? Promise.resolve()
    const next = previous
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
    const text = formatSessionEvent({ kind: 'wake', notes: fresh.map(publicNote) })
    const result = await link.request('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    const turn = isObject(result) && isObject(result.turn) ? result.turn : null
    if (typeof turn?.id === 'string' && !this.active.has(parentId))
      this.active.set(parentId, turn.id)
    this.store.dropNotes(parentId, Math.max(...fresh.map((note) => note.seq)))
    this.store.setWakes(parentId, this.store.wakes(parentId) + 1)
    this.host.log(`替会话 ${parentId}（${harness}）开了一个唤醒回合，带着 ${fresh.length} 条回报`)
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
    if (this.store.wakes(threadId) > 0) this.store.setWakes(threadId, 0)
    if (!this.host.enabled() || !Array.isArray(input)) return null
    const notes = this.store.notes(threadId)
    if (notes.length === 0) return null
    this.store.dropNotes(threadId, Math.max(...notes.map((note) => note.seq)))
    const event = formatSessionEvent({ kind: 'notes', notes: notes.map(publicNote) })
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

  /** 会话对象经过聚合面、发给声明了 sessionTree 的连接时：有父会话的挂上 litchLineage */
  decorate(thread: Record<string, unknown>): void {
    if (typeof thread.id !== 'string') return
    const lineage = this.lineage(thread.id)
    if (lineage) thread.litchLineage = lineage
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

  /** 脱离成独立会话 */
  detach(threadId: string): void {
    if (!this.store.detach(threadId))
      throw new DeviceError('unknownThread', `会话 ${threadId} 不是谁的子会话`, { threadId })
    this.lineageChanged(threadId)
  }

  // ---------- 提案 ----------

  propose(
    fields: Omit<SessionProposal, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'startedThreadId'>,
  ): SessionProposal {
    const createdAt = now()
    const proposal = this.store.addProposal({
      ...fields,
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + SESSION_TREE_LIMITS.proposalTtlSeconds,
    })
    this.proposalsChanged(fields.threadId)
    this.scheduleExpiry()
    return proposal
  }

  /** 一个会话上 pending 的提案（先把到期的收掉） */
  proposals(threadId: string): SessionProposal[] {
    this.expire()
    return this.store.pending(threadId)
  }

  /** 拿一个还 pending 的提案。没有、已经开始、不要了、过期了都抛错 */
  pendingProposal(proposalId: string): SessionProposal {
    this.expire()
    const proposal = this.store.proposal(proposalId)
    if (!proposal) throw new DeviceError('unsupported', `没有提案 ${proposalId}`)
    if (proposal.status !== 'pending')
      throw new DeviceError('unsupported', `提案 ${proposalId} 已经${STATUS_WORD[proposal.status]}`)
    return proposal
  }

  settleProposal(
    proposalId: string,
    status: 'started' | 'dismissed',
    threadId: string | null,
  ): void {
    const proposal = this.store.proposal(proposalId)
    if (proposal && this.store.settleProposal(proposalId, status, threadId))
      this.proposalsChanged(proposal.threadId)
  }

  private proposalsChanged(threadId: string): void {
    this.host.announce(
      SESSION_TREE_NOTIFICATION.proposalChanged,
      { threadId, proposals: this.store.pending(threadId) },
      EXTENSION.sessionTree,
    )
  }

  /** 到期的提案收掉，各自通知 */
  private expire(): void {
    const touched = new Set<string>()
    for (const proposal of this.store.expiring(now()))
      if (this.store.settleProposal(proposal.id, 'expired', null)) touched.add(proposal.threadId)
    for (const threadId of touched) this.proposalsChanged(threadId)
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

const STATUS_WORD: Record<SessionProposal['status'], string> = {
  pending: '在等用户',
  started: '开始了',
  dismissed: '被用户拒绝了',
  expired: '过期了',
}

/** 会话对象上的状态说它有回合在跑（等着用户答请求也算在跑） */
function busy(thread: unknown): boolean {
  const status = isObject(thread) && isObject(thread.status) ? thread.status : null
  return status?.type === 'active'
}

/** 队列里的回报去掉库里才有的字段 */
function publicNote(note: SessionEventNote): SessionEventNote {
  return { threadId: note.threadId, title: note.title, status: note.status, excerpt: note.excerpt }
}

/** 用户消息里标出来的一个元素（按 UTF-8 字节位置），整体往后挪 shift 个字节 */
function shifted(element: unknown, shift: number): unknown {
  if (!isObject(element) || !isObject(element.byteRange)) return element
  const range = element.byteRange
  const start = typeof range.start === 'number' ? range.start + shift : range.start
  const end = typeof range.end === 'number' ? range.end + shift : range.end
  return { ...element, byteRange: { ...range, start, end } }
}
