import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BACKGROUND_TASKS_NOTIFICATION,
  type LitchTurnOrigin,
} from '../../protocol/src/background-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  type BackgroundReport,
  notificationWithOrigin,
} from '../../shared/src/background-report.mjs'
import { BackgroundShells } from '../../shared/src/background-shell.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { declaredExtensions } from '../../shared/src/harness-declaration.mjs'
import { applyNotificationOptOut } from '../../shared/src/notification-opt-out.mjs'
import { PowerObserver, powerThreads } from '../../shared/src/power-observer.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { ProjectStore } from '../../shared/src/project-store.mjs'
import {
  BROADCAST_THREAD_NOTIFICATIONS,
  ProtocolError,
  ThreadNotFound,
} from '../../shared/src/protocol-contract.mjs'
import { QueueStore } from '../../shared/src/queue-store.mjs'
import { ServerRequests } from '../../shared/src/server-requests.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { type OpencodeApi, OpencodeError } from './api.mjs'
import { Asks } from './asks.mjs'
import { Catalog } from './catalog.mjs'
import { ClientTools } from './client-tools.mjs'
import { HarnessSettings } from './harness-settings.mjs'
import { HarnessError } from './harness-settings-shared.mjs'
import {
  type OcThread,
  type OcTurn,
  Projection,
  type ProjectionHooks,
  replay,
} from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { OpencodeRuntime } from './runtime.mjs'
import { Sessions } from './sessions.mjs'
import { OpencodeStore } from './store.mjs'
import { Turns } from './turns.mjs'

// 调试用：CHA_OPENCODE_TRACE 指向文件时逐行记录与客户端往来的协议消息，默认关闭。
const tracePath = process.env.CHA_OPENCODE_TRACE
const trace = (direction: 'in' | 'out', message: unknown) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ direction, message })}\n`)
}

export const EPHEMERAL_PREFIX = 'ephemeral-'

/** 三档权限预设（协议里的权限档标识），落到 OpenCode 上怎么做见 Sessions.tools 和 Sessions.permission */
export type Preset = ':read-only' | ':workspace' | ':danger-full-access'

/** 适配器替每个会话记的设置：OpenCode 的会话不记权限档和协作模式，模型和强度每次发消息时带上 */
export interface ThreadSettings {
  model: string | null
  effort: string | null
  preset: Preset
  plan: boolean
}

export interface LiveThread {
  projection: Projection
  // OpenCode 会话所在的目录：这个会话的请求都带它（x-opencode-directory）
  directory: string
  settings: ThreadSettings
  // 本进程内已受理的提交标识；同一个提交标识重复发来时返回同一回合
  submitted: Map<string, OcTurn>
  // 最近一个回合的提示词交给 OpenCode 了没有：交到了、没交成都算完。打断和插话要等它。
  delivered: Promise<void>
  // 当前回合开始时的权限档：完全访问在回合里自动放行，回合中途换档从下一个回合起作用
  turnPreset: Preset | null
  // 最近一个由客户端发起的回合是哪条连接发起的：客户端工具先交给它（client-tools.mts）
  starter: { turnId: string; peerId: string } | null
}

export class OpencodeServer {
  private readonly powerObserver = new PowerObserver()
  readonly store: OpencodeStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly live = new Map<string, LiveThread>()
  // 临时线程（客户端生成标题、摘要时用）：只在内存里，没有 OpenCode 会话，无人订阅即卸载。
  readonly ephemeral = new Map<string, LiveThread>()
  readonly runtime: OpencodeRuntime
  readonly catalog: Catalog
  readonly sessions: Sessions
  readonly asks: Asks
  readonly turns: Turns
  readonly clientTools: ClientTools
  readonly harness: HarnessSettings
  // 各连接握手时声明认识的扩展：服务端主动给的扩展内容只发给声明过的连接
  readonly declared = new Map<string, Set<string>>()
  private readonly loading = new Map<string, Promise<LiveThread>>()
  // 正在打开的会话这期间到的事件：打开之后补上
  private readonly buffered = new Map<string, Array<[string | null, any]>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  // 发给客户端并等回答的请求：发给会话的全部订阅连接，先答的生效（见 ServerRequests）。
  readonly requests = new ServerRequests((threadId, method, params) =>
    this.notify(threadId, method, params),
  )

  /**
   * 注入的后台 shell（shared/src/background-shell.mts）。设置 harness.opencode.backgroundShell 关着时是 null，
   * 模型看不到这几个工具、也不报后台任务的集合。进程归这个运行时，运行时退出时一起结束
   */
  readonly shells: BackgroundShells | null
  /** 后台任务的集合、回合的来历怎么加到给声明过 backgroundTasks 的连接的应答和通知上 */
  readonly report: BackgroundReport

  constructor(home: string, options: { backgroundShell?: boolean } = {}) {
    this.store = new OpencodeStore(home)
    this.shells = options.backgroundShell
      ? new BackgroundShells(join(home, 'background-shell'), {
          changed: (threadId) => this.publishBackground(threadId),
          finished: (threadId, tasks) =>
            void this.turns.wake(threadId, tasks).catch((error) =>
              this.notify(threadId, 'warning', {
                message: `后台命令结束后没能叫醒 OpenCode：${error instanceof Error ? error.message : String(error)}`,
              }),
            ),
        })
      : null
    this.report = {
      declared: (peerId) => this.declared.get(peerId)?.has(EXTENSION.backgroundTasks) === true,
      tasks: (threadId) => this.shells?.collection(threadId) ?? [],
      origin: (threadId, turnId) => this.origin(threadId, turnId),
      wakes: true,
    }
    this.projects = new ProjectStore(this.store.db, {
      find: (id) => this.knownThread(id),
      recency: (ids) => {
        const times = ids.flatMap((id) => {
          const thread = this.knownThread(id)
          const archived = this.sessions.archived(id)
          return thread && !thread.ephemeral && !archived ? [thread.updatedAt] : []
        })
        return times.length ? Math.max(...times) : null
      },
    })
    this.queue = new QueueStore(this.store.db)
    this.runtime = new OpencodeRuntime(home, {
      event: (directory, payload) => this.event(directory, payload),
      resync: () => void this.resync(),
      closed: (error) => this.runtimeClosed(error),
    })
    this.catalog = new Catalog(this)
    this.sessions = new Sessions(this)
    this.asks = new Asks(this)
    this.turns = new Turns(this)
    this.clientTools = new ClientTools(this)
    this.harness = new HarnessSettings(this)
  }

  api(): Promise<OpencodeApi> {
    return this.runtime.api()
  }

  // 打开着的会话以内存里的投影为准，没打开的看最近一次列清单记下的。
  knownThread(id: string): OcThread | null {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    return loaded?.projection.thread ?? this.sessions.known.get(id) ?? null
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (
      this.powerObserver.handle(peer, message, (ids) =>
        powerThreads(
          ids,
          () => [
            ...this.live.keys(),
            ...this.ephemeral.keys(),
            ...(this.shells?.runningThreadIds() ?? []),
          ],
          (id) => {
            const live = this.live.get(id) ?? this.ephemeral.get(id)
            return {
              active: live?.projection.status().type === 'active',
              background: Boolean(
                this.shells?.collection(id).some((task) => task.status === 'running'),
              ),
            }
          },
        ),
      )
    )
      return
    if (tracePath && !this.peers.has(peer.id)) {
      const send = peer.send.bind(peer)
      peer.send = (outgoing) => {
        trace('out', outgoing)
        send(outgoing)
      }
    }
    trace('in', message)
    this.peers.set(peer.id, peer)
    if (!('method' in message)) {
      this.requests.answer(peer, message)
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      if (message.method === 'initialize') {
        this.files.declare(peer, params)
        this.declared.set(peer.id, declaredExtensions(params))
        this.clientTools.declare(peer, params)
        applyNotificationOptOut(peer, params)
      }
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32603
      const text = error instanceof Error ? error.message : String(error)
      // 会话不在这里不记：官方桌面端找置顶会话在哪台机器上时，拿别处的会话号向每个入口都问。
      if (!(error instanceof ThreadNotFound))
        console.error(`[opencode] ${message.method} 失败（${code}）: ${text}`)
      // harness 详情设置的错误带 data（litch 字段说是哪一类，见 harness-config.mts）
      const data = error instanceof HarnessError ? { data: error.data } : {}
      peer.send({ jsonrpc: '2.0', id: message.id, error: { code, message: text, ...data } })
    } finally {
      // 这次请求可能让这条连接订阅了某个会话：把还在等人回答的请求补送给它（照上游恢复会话后重放挂起的请求）。
      this.requests.replay((threadId) => this.subscribers(threadId))
    }
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }

  subscribe(peer: RpcPeer, id: string): void {
    const ids = this.subscriptions.get(id) ?? new Set<string>()
    ids.add(peer.id)
    this.subscriptions.set(id, ids)
  }

  notify(threadId: string | null, method: string, params: any): void {
    if (method === 'item/started') params = { startedAtMs: Date.now(), ...params }
    if (method === 'item/completed')
      params = { startedAtMs: null, completedAtMs: Date.now(), ...params }
    // 会话的新建、状态、改名、归档这些和上游一样发给所有连接；临时线程的除外（不进列表）
    const everyone =
      threadId === null ||
      (BROADCAST_THREAD_NOTIFICATIONS.has(method) && !threadId.startsWith(EPHEMERAL_PREFIX))
    for (const peer of this.peers.values())
      if (everyone || (threadId !== null && this.subscriptions.get(threadId)?.has(peer.id))) {
        // 回合的来历只给声明了 backgroundTasks 的连接（另拷一份）
        const shaped = notificationWithOrigin(this.report, peer.id, threadId, method, params)
        peer.send({ method, params: threadId ? { threadId, ...shaped } : shaped })
      }
  }

  /** 后台 shell 的集合变了：整份发给所有声明过 backgroundTasks 的连接（不只是订阅者，侧栏要标没打开的会话） */
  publishBackground(threadId: string): void {
    // 临时会话的不发（只有建它的连接知道它）
    if (this.ephemeral.has(threadId)) return
    const params = { threadId, tasks: this.report.tasks(threadId), wakesOnFinish: true }
    for (const peer of this.peers.values())
      if (this.report.declared(peer.id))
        peer.send({ method: BACKGROUND_TASKS_NOTIFICATION.changed, params })
  }

  /** 回合是谁开的（记在库的元数据里，键是会话和回合号；回合号就是开头那条用户消息的号）。用户发起的是 undefined */
  origin(threadId: string, turnId: string): LitchTurnOrigin | undefined {
    return this.store.getMeta('turnOrigin', `${threadId}:${turnId}`) ?? undefined
  }

  setOrigin(threadId: string, turnId: string, origin: LitchTurnOrigin): void {
    this.store.setMeta('turnOrigin', `${threadId}:${turnId}`, origin)
  }

  /** 订阅着这个线程、还连着的连接，按订阅的先后 */
  subscribers(threadId: string): RpcPeer[] {
    return [...(this.subscriptions.get(threadId) ?? [])].flatMap((id) => this.peers.get(id) ?? [])
  }

  // 向订阅了该线程的全部客户端发起反向请求，先答的生效；signal 中止时撤回。
  call(threadId: string, method: string, params: any, signal?: AbortSignal): Promise<any> {
    return this.callWithNote(threadId, method, params, undefined, signal)
  }

  // withNote：声明了 declineWithNote 的连接收到的那份参数（决定列表里多一个“拒绝并附说明”）
  callWithNote(
    threadId: string,
    method: string,
    params: any,
    withNote: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const live = this.live.get(threadId)
    const turnId = live?.projection.active?.id ?? ''
    const full = (value: any) => ({ threadId, turnId, ...value })
    return this.requests.send(this.subscribers(threadId), threadId, method, () => full(params), {
      signal,
      replayable: true,
      paramsFor: withNote
        ? (target) =>
            this.declared.get(target.id)?.has(EXTENSION.declineWithNote)
              ? full(withNote)
              : undefined
        : undefined,
    })
  }

  /** 投影要问的几件事（按会话） */
  hooks(threadId: string): ProjectionHooks {
    return {
      recorded: (messageId) => {
        const saved = this.store.getMeta('input', `${threadId}:${messageId}`)
        return saved ? { content: saved.content, clientId: saved.clientId ?? null } : null
      },
      steer: (messageId) => this.store.getMeta('steer', `${threadId}:${messageId}`) !== null,
      contextWindow: (provider, model) => this.catalog.contextWindow(provider, model),
      mcpServers: () => this.catalog.mcpServers(),
      dynamicTool: (name) => this.clientTools.lookup(threadId, name),
      dynamicToolStarted: (itemId, name, input) =>
        this.clientTools.started(threadId, itemId, name, input),
      selfStarted: (messageId) => this.origin(threadId, messageId) !== undefined,
    }
  }

  /** 客户端发来的输入原样记一份（按会话和消息号）：回给客户端的用户消息就是它，实时回显和重读历史都读它 */
  remember(threadId: string, messageId: string, content: any[], clientId: string | null): void {
    this.store.setMeta('input', `${threadId}:${messageId}`, { content, clientId })
  }

  /** 打开会话：读 OpenCode 的会话和消息列表，重建投影；之后的事件接着往里归 */
  load(id: string): Promise<LiveThread> {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    if (loaded) return Promise.resolve(loaded)
    // 临时线程卸载后不复存在；不是 OpenCode 会话号的（别的 harness 的会话号）不必去问 OpenCode。
    if (id.startsWith(EPHEMERAL_PREFIX) || !id.startsWith('ses_'))
      return Promise.reject(new ThreadNotFound(id))
    const loading =
      this.loading.get(id) ??
      this.open(id).finally(() => {
        this.loading.delete(id)
        this.buffered.delete(id)
      })
    this.loading.set(id, loading)
    return loading
  }

  private async open(id: string): Promise<LiveThread> {
    this.buffered.set(id, [])
    const api = await this.api()
    const info = await api.request('GET', `/session/${id}`).catch((error) => {
      if (error instanceof OpencodeError && error.status === 404) throw new ThreadNotFound(id)
      throw new ProtocolError(-32602, error instanceof Error ? error.message : String(error))
    })
    const directory = String(info.directory)
    const [messages, status] = await Promise.all([
      api.request<any[]>('GET', `/session/${id}/message`, { directory }),
      api.request<Record<string, any>>('GET', '/session/status', { directory }),
    ])
    void this.catalog.refreshMcp(directory)
    const busy = ['busy', 'retry'].includes(status?.[id]?.type)
    const thread = this.sessions.thread(info)
    const projection = replay(
      thread,
      Array.isArray(messages) ? messages : [],
      this.hooks(id),
      info.revert?.messageID ?? null,
      busy,
    )
    const live: LiveThread = {
      projection,
      directory,
      settings: this.sessions.settings(id, info, messages),
      submitted: new Map(),
      delivered: Promise.resolve(),
      turnPreset: null,
      starter: null,
    }
    this.live.set(id, live)
    this.sessions.display(id, projection)
    // 打开期间到的事件补上（投影按部件号归并，重复的不会重复发）
    this.flush(id)
    // 打开之前就在等用户的权限请求和提问（适配器重启、别处发起的回合）补问
    void this.asks.resume(live)
    return live
  }

  /** 把一个打开着的会话从 OpenCode 重读一遍（回退之后，或者事件流断过） */
  async reload(live: LiveThread, notify: boolean): Promise<void> {
    const id = live.projection.thread.id
    const api = await this.api()
    const [info, messages, status] = await Promise.all([
      api.request('GET', `/session/${id}`),
      api.request<any[]>('GET', `/session/${id}/message`, { directory: live.directory }),
      api.request<Record<string, any>>('GET', '/session/status', { directory: live.directory }),
    ])
    const busy = ['busy', 'retry'].includes(status?.[id]?.type)
    if (!notify) {
      live.projection = replay(
        this.sessions.thread(info, live.projection.thread),
        messages,
        this.hooks(id),
        info.revert?.messageID ?? null,
        busy,
      )
      return
    }
    // 断线补齐：按先后再喂一遍，已经发过的不会重发，漏掉的照常发出去
    const emit = (method: string, params: any) => this.notify(id, method, params)
    const revert = info.revert?.messageID ?? null
    for (const entry of messages ?? []) {
      if (!entry?.info?.id || (revert && entry.info.id >= revert)) continue
      live.projection.message(entry.info, emit)
      for (const part of entry.parts ?? []) live.projection.part(part, emit)
    }
    if (!busy) live.projection.idle(emit)
    void this.asks.resume(live)
  }

  // 事件流断过又接上了：打开着的会话都重读一遍补齐
  // 缓冲着的事件按到达的先后补上。先摘掉缓冲，补的事件才不会又进缓冲。
  private flush(id: string): void {
    const pending = this.buffered.get(id) ?? []
    this.buffered.delete(id)
    for (const [dir, payload] of pending) this.event(dir, payload)
  }

  // 事件流断过又连上：打开着的会话逐个从 OpenCode 重读补齐。重读期间这个会话的事件先缓着，重读完再补上，
  // 还在流式输出的几段改为只认结束时的全文（Projection.staleStreams）。
  private async resync(): Promise<void> {
    const lives = [...this.live.values()]
    for (const live of lives) this.buffered.set(live.projection.thread.id, [])
    for (const live of lives) {
      const id = live.projection.thread.id
      try {
        await this.reload(live, true)
        live.projection.staleStreams()
      } catch (error) {
        console.error(`[opencode] 补齐会话 ${id} 失败: ${(error as Error).message}`)
      } finally {
        this.flush(id)
      }
    }
  }

  // OpenCode 不落盘的会话没有，这里只建内存里的线程，线程列表和 OpenCode 的会话存储里都不会出现。
  openEphemeral(peer: RpcPeer, cwd: string, settings: ThreadSettings): LiveThread {
    const now = Math.floor(Date.now() / 1000)
    const thread: OcThread = {
      id: `${EPHEMERAL_PREFIX}${crypto.randomUUID()}`,
      cwd,
      title: '',
      name: null,
      preview: '',
      createdAt: now,
      updatedAt: now,
      parentThreadId: null,
      agent: null,
      ephemeral: true,
    }
    const live: LiveThread = {
      projection: new Projection(thread, this.hooks(thread.id)),
      directory: cwd,
      settings,
      submitted: new Map(),
      delivered: Promise.resolve(),
      turnPreset: null,
      starter: null,
    }
    this.ephemeral.set(thread.id, live)
    this.subscribe(peer, thread.id)
    return live
  }

  // 无人订阅的临时线程立即卸载；返回卸载前它是否存在。
  releaseEphemeral(id: string): boolean {
    if (!this.ephemeral.has(id)) return false
    if (!this.subscriptions.get(id)?.size) {
      this.ephemeral.delete(id)
      this.subscriptions.delete(id)
    }
    return true
  }

  // /global/event 上的一条事件。只管打开着的会话；子代理会话的权限和提问归到它所属的主会话（Sessions.owner）。
  private event(directory: string | null, payload: any): void {
    const props = payload.properties ?? {}
    const sessionID: string | undefined =
      props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID
    if (payload.type === 'permission.asked') return void this.asks.permission(directory, props)
    if (payload.type === 'question.asked') return void this.asks.question(directory, props)
    if (['permission.replied', 'question.replied', 'question.rejected'].includes(payload.type))
      return void this.asks.answered(String(props.requestID))
    if (payload.type?.startsWith('mcp.')) this.harness.event(payload)
    if (!sessionID) return
    const pending = this.buffered.get(sessionID)
    if (pending) {
      pending.push([directory, payload])
      return
    }
    if (payload.type === 'session.updated' || payload.type === 'session.created')
      return void this.sessions.updated(props.info)
    if (payload.type === 'session.deleted') return void this.sessions.deleted(sessionID)
    const live = this.live.get(sessionID)
    if (!live) return
    const { projection } = live
    const notify = (method: string, params: any) => this.notify(sessionID, method, params)
    switch (payload.type) {
      case 'message.updated':
        projection.message(props.info, notify)
        if (props.info?.role === 'user') this.sessions.display(sessionID, projection)
        break
      case 'message.part.updated':
        projection.part(props.part, notify)
        if (props.part?.type === 'text') this.sessions.display(sessionID, projection)
        break
      case 'message.part.delta':
        projection.delta(
          String(props.partID),
          String(props.field),
          String(props.delta ?? ''),
          notify,
        )
        break
      case 'todo.updated':
        projection.todos(props.todos, notify)
        break
      case 'session.status':
        if (props.status?.type === 'idle') {
          projection.idle(notify)
          this.harness.idle()
        } else if (props.status?.type === 'retry') projection.retry(props.status, notify)
        break
      case 'session.idle':
        projection.idle(notify)
        this.harness.idle()
        break
      case 'session.error':
        projection.error(props.error, notify)
        break
    }
  }

  private runtimeClosed(error: Error): void {
    this.requests.reject((threadId) => this.live.has(threadId), 'OpenCode 进程已退出')
    for (const [id, live] of this.live)
      live.projection.fail(`OpenCode 进程已退出：${error.message}`, (method, params) =>
        this.notify(id, method, params),
      )
    this.live.clear()
  }

  closePeer(peer: RpcPeer): void {
    if (this.powerObserver.close(peer)) return
    this.peers.delete(peer.id)
    this.declared.delete(peer.id)
    this.clientTools.drop(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    for (const id of [...this.ephemeral.keys()]) this.releaseEphemeral(id)
    // 订阅者断开只摘掉它自己：别的连接还拿着的请求继续等，一条都不剩的才结束。
    this.requests.dropPeer(peer.id, '客户端已断开')
  }

  // signalled：是被结束信号要求退出的，交给 OpencodeRuntime.close 定怎么关 serve。
  // 只收一遍场：再次调用等的是同一遍
  private closing: Promise<void> | null = null
  close(signalled = false): Promise<void> {
    this.closing ??= (async () => {
      this.requests.reject(() => true, '适配器正在关闭')
      await this.shells?.close()
      await this.runtime.close(signalled)
      await this.clientTools.close()
      this.files.close()
      await this.processes.close()
      this.store.close()
    })()
    return this.closing
  }
}
