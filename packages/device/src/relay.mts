// 上游来的帧怎么转给客户端，以及服务端发起的请求（审批、提问）怎么原路送回。
// 每帧只解析一次，只看方法名、会话标识和请求号；不需要改的帧把收到的原文原样发出去，不重新序列化：路由层给每条消息加的开销要压到最低。
//
// 会话对象经过这里时（应答里的、会话开始的通知里的），工作区、分区、置顶换成设备层的值：
// 归属存在设备层，引擎自己那一份和聚合面互不相通。
import { isClientToolNamespace } from '../../protocol/src/client-tools.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import type { DeviceTools } from './device-tools.mjs'
import { isHarnessConfigNotification } from './harness-config.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import type { ForwardedRequest, UpstreamLink } from './upstream.mjs'
import { DeviceError, type Frame, idKey, isObject, type RpcId, toRpcError } from './wire.mjs'
import type { Expectation, Workspaces } from './workspaces.mjs'

export interface RelayHost {
  /** 发给客户端 */
  send(text: string): void
  /** 客户端握手时退订了这个通知 */
  optedOut(method: string): boolean
  /** 客户端握手时声明认识这个扩展 */
  declares(extension: string): boolean
  index: ThreadIndex
  workspaces: Workspaces
  /** 会话开始的通知最多扣多久（毫秒），见 SessionTiming.startedHoldMs */
  startedHoldMs: number
  log(line: string): void
  /** 转发给上游的一个请求有了结果（应答到了，或者上游断开了）：记摘要用。error 是 null 表示成功 */
  answered?(link: UpstreamLink, id: RpcId, error: unknown): void
  /** 原生 codex 的客户端工具调用交给设备进程挑执行方（client-tools.mts），这几处要告诉它 */
  clientTools: RelayClientTools
  /** 由设备进程自己执行的命名空间：这类 item/tool/call 不管哪种上游都在这里拦下交给它（device-tools.mts） */
  deviceTools: Pick<DeviceTools, 'has' | 'dispatch' | 'turnEnded'>
  /** 上游的每条通知都给看一眼（替原生 codex 翻译 harness 详情设置的，要从里面看登录的结果）。只看不改 */
  observe(link: UpstreamLink, method: string, params: Record<string, unknown>): void
  /** 会话树要看的几样（session-tree.mts） */
  sessions: RelaySessions
  /** 工作树主人的会话对象挂 litchWorktree；目录在工作树里的会话记成共用者（worktrees.mts） */
  worktrees: {
    decorate(thread: Record<string, unknown>): void
    adopt(thread: Record<string, unknown>): void
  }
  /** 后台任务（background.mts） */
  background: RelayBackground
}

export interface RelayBackground {
  /** 上游的每条通知都给看一眼（在会话树之前：回报里要数还有几个后台任务在跑） */
  notification(link: UpstreamLink, method: string, params: Record<string, unknown>): void
  /** 会话对象经过、这条连接声明了 backgroundTasks：原生 codex 的挂上派生的集合 */
  decorate(thread: Record<string, unknown>): void
  /** thread/resume 成功应答（带着历史）：原生 codex 的从历史里补集合 */
  resumed(link: UpstreamLink, thread: Record<string, unknown>): void
}

export interface RelaySessions {
  clientAnswered(harness: string, threadId: string, requestId: RpcId): void
  /** 客户端发起或成功插话的回合：只要收到用户输入就算用户回合 */
  clientTurn(harness: string, turnId: string): void
  /** 一个回合开始或结束了（turn/started、turn/completed 的参数） */
  turnEvent(harness: string, method: string, params: Record<string, unknown>): void
  /** 一个条目开始或结束了（item/started、item/completed 的参数）：认别的会话经 harness 自己的收件箱发来的消息 */
  itemEvent(params: Record<string, unknown>): void
  /** 会话对象经过、这条连接声明了 sessionTree：挂上 litchLineage */
  decorate(thread: Record<string, unknown>): void
  /** 会话删掉了（thread/delete 成功、thread/deleted 通知） */
  deleted(threadId: string): void
}

/**
 * offer、resolved 只对 dialect.clientToolsByDevice 的上游（原生 codex）调用；订阅、回合的几样对每个上游都调：
 * 命令行的调用（litch/clientTool/invoke）按会话找发起回合的 Litch，哪个 harness 的会话都要
 */
export interface RelayClientTools {
  /** 一份 litch_ 命名空间的 item/tool/call 到了：不往下转 */
  offer(link: UpstreamLink, frame: Frame, upstreamId: RpcId): void
  /** 上游说这个请求有结果了。返回 true：是客户端工具调用，这条通知不往下转 */
  resolved(link: UpstreamLink, requestId: RpcId): boolean
  /** 这条连接订阅了会话（新建、恢复、分叉成功） */
  subscribed(link: UpstreamLink, threadId: string): void
  /** 这条连接发起的回合开始了（turn/start 的应答） */
  turnStarted(link: UpstreamLink, turnId: string): void
  /** 会话的一个回合开始了（turn/started 通知） */
  turnBegan(link: UpstreamLink, threadId: string, turnId: string): void
  turnEnded(link: UpstreamLink, turnId: string): void
}

/** 应答成功就说明这条连接订阅了会话的方法 */
const SUBSCRIBING = new Set(['thread/start', 'thread/resume', 'thread/fork'])

type Tracked = Expectation & {
  link: UpstreamLink
  /** born：应答到之前先到的会话开始通知，扣在这里，等归属记好了再放出去 */
  held: Frame[]
  /**
   * born：扣通知的期限。上游一直不应答的话不能一直扣下去——那样这条连接再也收不到这个上游上
   * 任何会话开始的通知（别的窗口、命令行里新开的都算）。null：没有在扣（不是 born，或者已经到点放掉了）
   */
  holdTimer: NodeJS.Timeout | null
}

/** 引擎自己的项目通知：说的是它那一份互不相通的项目存储，聚合面上的项目通知只由设备层发 */
const ENGINE_PROJECT_NOTIFICATIONS = new Set(['project/changed', 'thread/project/updated'])

interface PendingServerRequest {
  /** null：设备进程替原生 codex 转来的客户端工具调用，答复交给 onAnswer（client-tools.mts） */
  link: UpstreamLink | null
  onAnswer?: (frame: Frame) => void
  /** 上游用的请求号 */
  upstreamId: RpcId
  /** 客户端看到的请求号。和别的上游撞了的时候才和 upstreamId 不同 */
  facingId: RpcId
  threadId: string | null
}

export class Relay {
  private readonly host: RelayHost
  /** 还在等客户端答复的服务端请求，键是客户端看到的请求号 */
  private readonly pending = new Map<string, PendingServerRequest>()
  /** 换过请求号的：每个上游一张表，键是上游的请求号 */
  private readonly renamed = new Map<UpstreamLink, Map<string, RpcId>>()
  /** 转发出去、应答回来时还有事要做的请求，键是客户端的请求号 */
  private readonly tracked = new Map<string, Tracked>()
  /** 转发出去的请求应答时要顺手做的事（成功、失败各一样），键是客户端的请求号 */
  private readonly afterwards = new Map<
    string,
    { work: (result: unknown) => void; failed?: () => void }
  >()
  private sequence = 0

  constructor(host: RelayHost) {
    this.host = host
  }

  /** 上游发来的一帧。request：这一帧是哪个转发过去的请求的应答 */
  upstream(link: UpstreamLink, frame: Frame, raw: string, request?: ForwardedRequest): void {
    if (typeof frame.method !== 'string') this.response(link, frame, raw, request)
    else if (frame.id != null) {
      if (isObject(frame.params)) this.host.observe(link, frame.method, frame.params)
      this.serverRequest(link, frame, frame.id, raw)
    } else this.notification(link, frame, frame.method, raw)
  }

  /** 这个请求（马上要转给上游）成功应答时调一下 work；失败、上游断开时调 failed（有的话） */
  after(id: RpcId, work: (result: unknown) => void, failed?: () => void): void {
    this.afterwards.set(idKey(id), failed ? { work, failed } : { work })
  }

  /** 一个请求刚转给了上游，它的应答回来时设备层还有事要做 */
  expect(link: UpstreamLink, id: RpcId, expectation: Expectation): void {
    const tracked: Tracked = { ...expectation, link, held: [], holdTimer: null }
    if (tracked.kind === 'born')
      tracked.holdTimer = setTimeout(() => this.release(tracked), this.host.startedHoldMs)
    this.tracked.set(idKey(id), tracked)
  }

  /**
   * 等新建的应答等到了期限：扣着的会话开始通知放出去，之后也不再为它扣。
   * 这个期待本身留着：应答哪怕迟到，会话照样落进工作区，那时设备层会发一条归属变化的通知
   * （Workspaces.adoptThread），先放出去的那条通知上空着的归属靠它补上。
   */
  private release(tracked: Tracked): void {
    tracked.holdTimer = null
    const held = tracked.held.splice(0)
    this.host.log(
      `${tracked.link.harness} 的新建会话 ${this.host.startedHoldMs} 毫秒没有应答，扣着的 ${held.length} 条会话开始通知先放出去`,
    )
    for (const frame of held)
      this.notification(tracked.link, frame, 'thread/started', JSON.stringify(frame))
  }

  /** 不再扣了：应答到了、上游断了、连接关了 */
  private settle(tracked: Tracked): void {
    if (tracked.holdTimer) clearTimeout(tracked.holdTimer)
    tracked.holdTimer = null
  }

  /** 客户端这条连接关了：扣着的不用放了，计时也撤掉 */
  close(): void {
    for (const tracked of this.tracked.values()) this.settle(tracked)
    this.tracked.clear()
    this.afterwards.clear()
  }

  /** 应答里有会话对象的（新建、恢复、读取、分叉……）：记下它属于谁，打上 harness，换上设备层的归属 */
  private response(
    link: UpstreamLink,
    frame: Frame,
    raw: string,
    request: ForwardedRequest | undefined,
  ): void {
    const key = frame.id == null ? null : idKey(frame.id)
    const tracked = key === null ? undefined : this.tracked.get(key)
    if (key !== null && tracked) {
      this.tracked.delete(key)
      this.settle(tracked)
    }
    const result = frame.result
    const afterwards = key === null ? undefined : this.afterwards.get(key)
    if (key !== null && afterwards) this.afterwards.delete(key)
    if (afterwards && frame.error === undefined) afterwards.work(result)
    else if (afterwards) afterwards.failed?.()
    if (tracked && frame.error === undefined) this.fulfil(link, tracked, result)
    if (request && frame.error === undefined) this.clientToolsSaw(link, request.method, result)
    if (request?.method === 'thread/resume' && isObject(result) && isObject(result.thread))
      this.host.background.resumed(link, result.thread)
    let changed = false
    if (isObject(result)) {
      if (isObject(result.thread))
        this.host.observe(link, 'thread/snapshot', { thread: result.thread })
      changed = this.stamp(link, result.thread)
      // 搜索结果这类：一页里每一项带着一个会话对象
      if (Array.isArray(result.data))
        for (const item of result.data)
          if (isObject(item) && this.stamp(link, item.thread)) changed = true
    }
    // 上游回的错误原样带回去；只有它那种“话”里意思不一样的才换（原生 codex 对不认识的方法回的是“无效请求”）
    const failure = request && isObject(frame.error) ? frame.error : null
    const replaced =
      request && failure ? link.dialect.rejection(link.harness, request.method, failure) : null
    if (request) this.host.answered?.(link, request.id, replaced ?? frame.error ?? null)
    if (replaced) this.host.send(JSON.stringify({ id: frame.id, error: replaced }))
    else this.host.send(changed ? JSON.stringify(frame) : raw)
    // 扣着的会话开始通知现在可以放了：归属已经记好，放出去的时候带得上
    for (const held of tracked?.held ?? [])
      this.notification(link, held, 'thread/started', JSON.stringify(held))
  }

  /** 订阅了哪个会话、发起了哪个回合：设备进程替原生 codex、替命令行挑客户端工具的执行方时要用 */
  private clientToolsSaw(link: UpstreamLink, method: string, result: unknown): void {
    if (!isObject(result)) return
    const thread = isObject(result.thread) ? result.thread : null
    if (SUBSCRIBING.has(method) && typeof thread?.id === 'string')
      this.host.clientTools.subscribed(link, thread.id)
    const turn = isObject(result.turn) ? result.turn : null
    if (method === 'turn/start' && typeof turn?.id === 'string') {
      this.host.clientTools.turnStarted(link, turn.id)
      this.host.sessions.clientTurn(link.harness, turn.id)
    }
    // 用户可以在自发回合中插话；按成功应答里的真实回合登记，失败或设备自己的插话不经过这里。
    if (method === 'turn/steer' && typeof result.turnId === 'string')
      this.host.sessions.clientTurn(link.harness, result.turnId)
  }

  /** 上游说成了：把设备层这边该记的记上 */
  private fulfil(link: UpstreamLink, tracked: Tracked, result: unknown): void {
    const { index, workspaces } = this.host
    if (tracked.kind === 'gone') {
      workspaces.forget(tracked.threadId)
      index.forget(tracked.threadId)
      this.host.sessions.deleted(tracked.threadId)
    } else if (tracked.kind === 'shelved') index.setArchived(tracked.threadId, tracked.archived)
    else {
      const thread = isObject(result) ? result.thread : null
      if (!isObject(thread) || typeof thread.id !== 'string') return
      // 先登记再归：归属要认会话在不在、是不是临时的（临时会话的归属只活在这次运行里）
      this.see(link, thread.id, thread)
      workspaces.adoptThread(thread.id, tracked.projectId)
    }
  }

  /**
   * 给会话对象打上 harness 并登记进索引，工作区、分区、置顶换成设备层的。
   * 这里拿到的是会话对象上的标识，也就是最终标识：
   * Pi 新建会话时内部用过的临时标识不会出现在会话对象上，所以不会被登记。
   */
  private stamp(link: UpstreamLink, thread: unknown): boolean {
    if (!isObject(thread) || typeof thread.id !== 'string') return false
    this.see(link, thread.id, thread)
    this.host.worktrees.adopt(thread)
    thread.harness = link.harness
    this.host.workspaces.decorate(thread.id, thread)
    if (this.host.declares(EXTENSION.sessionTree)) this.host.sessions.decorate(thread)
    if (this.host.declares(EXTENSION.backgroundTasks)) this.host.background.decorate(thread)
    if (this.host.declares(EXTENSION.worktrees)) this.host.worktrees.decorate(thread)
    return true
  }

  private see(link: UpstreamLink, threadId: string, thread: Record<string, unknown>): void {
    this.host.index.see(
      { id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      link.harness,
    )
  }

  /** 这个上游上有没有正等着应答、要落进工作区、而且还没等过期限的新建请求 */
  private bearing(link: UpstreamLink): Tracked | null {
    for (const tracked of this.tracked.values())
      if (tracked.kind === 'born' && tracked.holdTimer !== null && tracked.link === link)
        return tracked
    return null
  }

  private notification(link: UpstreamLink, frame: Frame, method: string, raw: string): void {
    // 引擎自己那一份项目存储的变化不上聚合面（官方桌面端在它的入口上改项目时引擎会广播）
    if (ENGINE_PROJECT_NOTIFICATIONS.has(method)) return
    const fields = isObject(frame.params) ? frame.params : null
    const threadId = typeof fields?.threadId === 'string' ? fields.threadId : null
    let changed = false
    if (method === 'thread/started') {
      const thread = fields?.thread
      // 有的引擎先发会话开始的通知再回新建的应答。会话要落进哪个工作区是记在应答上的，
      // 所以这个上游上有带工作区的新建还没应答时，会话开始的通知先扣着，应答到了、归属记好了再放，
      // 免得通知里的归属是空的。分不出哪一条是自己那个会话的（应答没到就不知道标识，
      // 索引是各连接共用的，别的连接可能先见到它），所以这段工夫里的都扣；上游断开时照常放出去，
      // 应答等得太久（startedHoldMs）也放出去，不一直扣着
      const waiting = this.bearing(link)
      if (waiting) {
        waiting.held.push(frame)
        return
      }
      changed = this.stamp(link, thread)
    } else if (method === 'thread/deleted' && threadId) {
      this.host.workspaces.forget(threadId)
      this.host.index.forget(threadId)
      this.host.sessions.deleted(threadId)
    } else if (method === 'thread/archived' && threadId) this.host.index.setArchived(threadId, true)
    else if (method === 'thread/unarchived' && threadId)
      this.host.index.setArchived(threadId, false)
    else if (
      method === 'serverRequest/resolved' &&
      fields &&
      fields.requestId != null &&
      link.dialect.clientToolsByDevice &&
      this.host.clientTools.resolved(link, fields.requestId as RpcId)
    )
      return
    else if (method === 'serverRequest/resolved' && fields && fields.requestId != null) {
      // 上游说这个请求已经有结果了（客户端答了、回合结束作废了）：不用再等客户端
      const renamed = this.renamed.get(link)
      const facing = renamed?.get(idKey(fields.requestId))
      this.pending.delete(idKey(facing ?? fields.requestId))
      if (facing !== undefined) {
        renamed?.delete(idKey(fields.requestId))
        fields.requestId = facing
        changed = true
      }
    }
    if (fields) this.host.background.notification(link, method, fields)
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = isObject(fields?.turn) ? fields.turn : null
      if (typeof turn?.id === 'string' && method === 'turn/completed') {
        this.host.clientTools.turnEnded(link, turn.id)
        this.host.deviceTools.turnEnded(link.harness, turn.id)
      } else if (typeof turn?.id === 'string' && threadId)
        this.host.clientTools.turnBegan(link, threadId, turn.id)
      if (fields) this.host.sessions.turnEvent(link.harness, method, fields)
    }
    if (fields && (method === 'item/started' || method === 'item/completed'))
      this.host.sessions.itemEvent(fields)
    if (fields) this.host.observe(link, method, fields)
    // harness 详情设置的通知（引擎发的配置变了、登录有进展）只给声明过这项扩展的连接
    if (isHarnessConfigNotification(method) && !this.host.declares(EXTENSION.harnessConfig)) return
    if (this.host.optedOut(method)) return
    // 带会话标识的通知原样转发；不带的（账号变化、MCP 状态、技能变化、限额等）加上是哪个 harness 发的
    if (threadId === null) {
      frame.params = { ...fields, harness: link.harness }
      changed = true
    }
    this.host.send(changed ? JSON.stringify(frame) : raw)
  }

  /**
   * 服务端发起的请求原样转给客户端，记下它来自哪个上游。
   * 适配器的引擎用随机的唯一标识当请求号，跨引擎不会撞；原生 codex 用的是递增的整数，会撞。
   * 撞了就给后来的那个换一个请求号，应答和“已经有结果”的通知都按表换回去。
   */
  private serverRequest(link: UpstreamLink, frame: Frame, upstreamId: RpcId, raw: string): void {
    const fields = isObject(frame.params) ? frame.params : null
    const threadId = typeof fields?.threadId === 'string' ? fields.threadId : null
    // 设备进程自己执行的命名空间（litch_sessions……）：哪种上游发来的都不转给客户端，在这里答。
    // 原生 codex 发给每条订阅连接各一份，注册表并成一次；答复从收到这一份的上游连接回
    if (
      frame.method === 'item/tool/call' &&
      fields &&
      this.host.deviceTools.has(fields.namespace)
    ) {
      this.host.deviceTools.dispatch(link.harness, fields, (result) => {
        if (!link.available) return false
        link.reply(JSON.stringify({ id: upstreamId, result }))
        return true
      })
      return
    }
    // 原生 codex 发给每条订阅连接的客户端工具调用：由设备进程挑一条转（client-tools.mts）
    if (
      frame.method === 'item/tool/call' &&
      link.dialect.clientToolsByDevice &&
      isClientToolNamespace(fields?.namespace as string | undefined)
    ) {
      this.host.clientTools.offer(link, frame, upstreamId)
      return
    }
    let facingId = upstreamId
    // 这个上游的协议里没有、要由聚合面补的内容（原生 codex 的文件改动审批不带决定列表），
    // 只补给声明过相应扩展的连接
    let changed =
      fields !== null &&
      typeof frame.method === 'string' &&
      link.dialect.serverRequest(frame.method, fields, (extension) => this.host.declares(extension))
    if (this.pending.has(idKey(upstreamId))) {
      facingId = `litch:${link.harness}:${++this.sequence}`
      const renamed = this.renamed.get(link) ?? new Map<string, RpcId>()
      renamed.set(idKey(upstreamId), facingId)
      this.renamed.set(link, renamed)
      frame.id = facingId
      changed = true
    }
    this.pending.set(idKey(facingId), { link, upstreamId, facingId, threadId })
    this.host.send(changed ? JSON.stringify(frame) : raw)
  }

  /**
   * 设备进程替原生 codex 挑中这条连接执行一次客户端工具调用：转给客户端，答复交给 onAnswer。
   * 请求号和这条连接上别的待答请求撞了就换一个。返回客户端看到的请求号
   */
  deliver(harness: string, frame: Frame, onAnswer: (frame: Frame) => void): RpcId {
    const upstreamId = frame.id as RpcId
    const fields = isObject(frame.params) ? frame.params : null
    const threadId = typeof fields?.threadId === 'string' ? fields.threadId : null
    const facingId = this.pending.has(idKey(upstreamId))
      ? `litch:${harness}:${++this.sequence}`
      : upstreamId
    this.pending.set(idKey(facingId), { link: null, onAnswer, upstreamId, facingId, threadId })
    this.host.send(JSON.stringify({ ...frame, id: facingId }))
    return facingId
  }

  /** deliver 转过来的调用了结了（不是这条连接答的）：说一声这个请求有结果了，客户端的卡片收得掉 */
  withdraw(facingId: RpcId, threadId: string | null): void {
    if (!this.pending.delete(idKey(facingId))) return
    if (this.host.optedOut('serverRequest/resolved')) return
    this.host.send(
      JSON.stringify({
        method: 'serverRequest/resolved',
        params: { threadId, requestId: facingId },
      }),
    )
  }

  /** 这个 harness 发来的这条请求（上游的请求号）是不是转给了客户端、还在等它答 */
  holds(harness: string, upstreamId: RpcId): boolean {
    const key = idKey(upstreamId)
    for (const entry of this.pending.values())
      if (entry.link?.harness === harness && idKey(entry.upstreamId) === key) return true
    return false
  }

  /** 客户端对服务端请求的应答：送回发出请求的那个上游 */
  answer(frame: Frame, raw: string): void {
    const entry = this.pending.get(idKey(frame.id))
    // 找不到：那个上游已经断开，或者它已经说过这个请求有结果了
    if (!entry) return
    this.pending.delete(idKey(frame.id))
    if (entry.link && entry.threadId && frame.error === undefined && 'result' in frame)
      this.host.sessions.clientAnswered(entry.link.harness, entry.threadId, entry.upstreamId)
    if (!entry.link) entry.onAnswer?.(frame)
    else if (entry.upstreamId === entry.facingId) entry.link.reply(raw)
    else entry.link.reply(JSON.stringify({ ...frame, id: entry.upstreamId }))
  }

  /** 一个上游断开了：没等到应答的请求回错误，它发来还在等答复的请求作废 */
  dropped(link: UpstreamLink, forwarded: ForwardedRequest[]): void {
    const harness = link.harness
    for (const request of forwarded) {
      const error = new DeviceError(
        'harnessUnavailable',
        `${harness} 的连接断开了，${request.method} 没有等到应答`,
        { harness, method: request.method },
      )
      this.host.answered?.(link, request.id, error)
      this.host.send(JSON.stringify({ id: request.id, error: toRpcError(error) }))
    }
    for (const [key, entry] of this.pending) {
      if (entry.link !== link) continue
      this.pending.delete(key)
      // 上游不在了，没有人会来说“这个请求已经有结果了”，替它说一声，客户端的卡片才收得掉
      if (entry.threadId && !this.host.optedOut('serverRequest/resolved'))
        this.host.send(
          JSON.stringify({
            method: 'serverRequest/resolved',
            params: { threadId: entry.threadId, requestId: entry.facingId },
          }),
        )
    }
    this.renamed.delete(link)
    for (const request of forwarded) {
      this.afterwards.get(idKey(request.id))?.failed?.()
      this.afterwards.delete(idKey(request.id))
    }
    // 等不到应答了，设备层这边该记的也就不记了；扣着的会话开始通知照常放出去
    const held: Frame[] = []
    for (const [key, tracked] of this.tracked) {
      if (tracked.link !== link) continue
      this.tracked.delete(key)
      this.settle(tracked)
      held.push(...tracked.held)
    }
    for (const frame of held)
      this.notification(link, frame, 'thread/started', JSON.stringify(frame))
  }
}
