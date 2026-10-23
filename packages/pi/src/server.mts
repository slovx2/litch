import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  clientToolNamespaces,
  isClientToolNamespace,
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { declaredExtensions } from '../../shared/src/harness-declaration.mjs'
import { applyNotificationOptOut } from '../../shared/src/notification-opt-out.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { ProjectStore, threadsTable } from '../../shared/src/project-store.mjs'
import {
  BROADCAST_THREAD_NOTIFICATIONS,
  ProtocolError,
  ThreadNotFound,
} from '../../shared/src/protocol-contract.mjs'
import { QueueStore } from '../../shared/src/queue-store.mjs'
import { ServerRequests } from '../../shared/src/server-requests.mjs'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { previewFileChange, targetPath } from './approval-preview.mjs'
import {
  type ApprovalDecision,
  approvalKind,
  approvalRequest,
  CANCELLED_MESSAGE,
  commandOf,
  decisionOf,
  deniedMessage,
  grantKey,
  type ToolCallAsk,
  type ToolCallBlock,
  toolReason,
  unansweredMessage,
} from './approvals.mjs'
import { clientTools } from './dynamic-tools.mjs'
import { NativeFiles, nativeBranch, sessionIndexDirectories } from './native-files.mjs'
import { discoverSessions, inputRecord, projectHistory, type SentMessage } from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { type LiveSession, openSession, planState } from './runtime.mjs'
import type { SessionManager } from './sdk.mjs'
import { PiStore, type PiThread, type PiTurn } from './store.mjs'
import { contentBefore, inputPreview, onEvent, runTurn } from './turn.mjs'
import { createUi } from './ui.mjs'

export interface ActiveTurn {
  thread: PiThread
  turn: PiTurn
  peer?: RpcPeer
  live?: LiveSession
  stopped: boolean
  // declined：用户在审批里否决了这次调用；preview：条目上的差异是审批之前预先算的，还不是实际结果；
  // seen：命令到上一份输出快照为止一共输出了多少字节，见 command-output.mts。
  tools: Map<
    string,
    {
      item: any
      args: any
      before?: string | null | undefined
      declined?: boolean
      preview?: boolean
      seen?: number | undefined
    }
  >
  done: Promise<void>
  resolve: () => void
  /** 还没回显的客户端消息，按先后：回合开头那条、之后每条插话。Pi 里每来一条新的用户消息就对上一条 */
  pending: SentMessage[]
  native?: boolean
  notices?: string[]
  /** 最近一条助手消息停在 length 上、一个字一次调用都没给出来（上下文满了），见 turn.mts 的 contextError */
  truncated?: boolean
  /** 这个回合里自动压缩最近一次的失败原因；之后压成了就清掉 */
  compactionError?: string
  /** 正在压缩：已经发了开始、还没完成的那个 contextCompaction 条目（turn.mts、compaction.mts） */
  compacting?: any
}
export class PiServer {
  readonly store: PiStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly sessions = new Map<string, LiveSession>()
  readonly active = new Map<string, ActiveTurn>()
  readonly nativeFiles = new NativeFiles()
  readonly background = new Map<string, Set<string>>()
  /** gotgenes 的 agentId → 子会话的线程号，子会话建好时记（runtime.mts）；重新载入的历史从父会话的记录里配 */
  readonly subagentThreads = new Map<string, string>()
  private readonly loading = new Map<string, Promise<LiveSession>>()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  // 发给客户端并等回答的请求：发给会话的全部订阅连接，先答的生效（见 ServerRequests）。
  private readonly requests = new ServerRequests((threadId, method, params) =>
    this.notify(threadId, method, params),
  )
  private indexing: Promise<void> | null = null
  private closing = false
  private readonly indexed = new Map<string, any[]>()
  /** 正在等用户回答的会话，值是还没答完的提问数 */
  private readonly asking = new Map<string, number>()
  /** 正在等用户审批的会话，值是还没答复的审批数 */
  private readonly approving = new Map<string, number>()
  /** 用户答了“这个会话里以后都允许”的那些：会话标识 → 放行的键（approvals.mts 的 grantKey）。只在内存里 */
  private readonly grants = new Map<string, Set<string>>()
  /** 有过订阅者、还没发 thread/closed 的会话：没人订阅、释放掉了时照上游发一条（closeUnused） */
  private readonly attached = new Set<string>()
  /** 每条连接握手时声明认识的扩展：连接标识 → 扩展名 */
  private readonly declared = new Map<string, Set<string>>()
  /** 每条连接握手时声明能执行的客户端工具命名空间（clientTools 扩展）：连接标识 → 命名空间 */
  private readonly toolNamespaces = new Map<string, ReadonlySet<string>>()
  /** 工具执行之前问不问用户。运行时起来时定下，之后不变（设置 harness.pi.approvals，改了要重启运行时） */
  readonly approvals: boolean
  constructor(home: string, options: { approvals?: boolean } = {}) {
    this.approvals = options.approvals === true
    this.store = new PiStore(home)
    this.projects = new ProjectStore(this.store.db, threadsTable(this.store.db))
    this.queue = new QueueStore(this.store.db)
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    this.peers.set(peer.id, peer)
    if (!('method' in message)) {
      this.requests.answer(peer, message)
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      // 记下这条连接握手时声明认识的扩展：服务端主动给的扩展内容只发给声明过的连接。
      // 也记下它退订的通知：从这里起，这条连接上不发名单里的通知。
      if (message.method === 'initialize') {
        this.declared.set(peer.id, declaredExtensions(params))
        this.toolNamespaces.set(peer.id, clientToolNamespaces(params))
        applyNotificationOptOut(peer, params)
      }
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
          // 扩展约定的错误带 data（harnessConfig 的 HarnessConfigError）
          ...(error instanceof ProtocolError && 'data' in error ? { data: error.data } : {}),
        },
      })
    } finally {
      // 这次请求可能让这条连接订阅了某个会话：应答发出之后，把还在等人回答的请求补送给它，
      // 先后与原生“恢复会话后重放挂起的请求”一致。
      this.requests.replay((threadId) => this.subscribers(threadId))
      void this.releaseUnused().catch(() => {})
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
  /**
   * 会话现在的状态。回合进行中又在等用户时带上对应的标记，客户端靠它提示“待审批”“待回答”。
   * 两种标记和次序都照 codex 的（app-server 的 thread_status.rs）：有审批在等是 waitingOnApproval，
   * 有提问在等是 waitingOnUserInput，可以同时有。
   */
  status(threadId: string): any {
    if (!this.active.has(threadId)) return { type: 'idle' }
    return {
      type: 'active',
      activeFlags: [
        ...(this.approving.has(threadId) ? ['waitingOnApproval'] : []),
        ...(this.asking.has(threadId) ? ['waitingOnUserInput'] : []),
      ],
    }
  }
  // 等用户的这段时间把会话标成在等，等完改回来。同一种事有几件在等时数着，都等完才去掉标记。
  private async waiting<T>(
    pending: Map<string, number>,
    threadId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    pending.set(threadId, (pending.get(threadId) ?? 0) + 1)
    this.notify(threadId, 'thread/status/changed', { status: this.status(threadId) })
    try {
      return await work()
    } finally {
      const left = (pending.get(threadId) ?? 1) - 1
      if (left > 0) pending.set(threadId, left)
      else pending.delete(threadId)
      // 回合已经结束的不用再报：结束时会报一次空闲
      if (this.active.has(threadId))
        this.notify(threadId, 'thread/status/changed', { status: this.status(threadId) })
    }
  }
  /** 向用户提一个问题。等回答的这段时间把会话标成在等用户，答完或取消后改回来 */
  private ask(
    peer: RpcPeer | undefined,
    threadId: string,
    params: any,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.waiting(this.asking, threadId, () =>
      this.call(peer, threadId, 'item/tool/requestUserInput', params, signal),
    )
  }
  /**
   * 工具执行之前问用户（只在打开了审批时才挂上，钩子在 runtime.mts）。返回 undefined 是放行；
   * 返回的对象让 Pi 不执行这次调用，reason 成为工具结果，模型看得到。
   * 一直等到有答复，不设时限。拿不到答复的一律不执行：没有客户端连着、拿着请求的连接都断了、
   * 回合停了、客户端回的是错误。请求发给谁、先答的生效、作废时的通知都走 ServerRequests 现成的路。
   */
  private async approve(
    peer: RpcPeer,
    thread: PiThread,
    ask: ToolCallAsk,
  ): Promise<ToolCallBlock | undefined> {
    const client = clientTools(thread.dynamicTools).some((tool) => tool.piName === ask.toolName)
    const kind = approvalKind(ask, client)
    if (!kind) return undefined
    const key = grantKey(kind, ask, thread.cwd, targetPath(thread.cwd, ask.input.path))
    if (this.grants.get(thread.id)?.has(key)) return undefined
    const active = this.active.get(thread.id)
    if (!active) return { block: true, reason: unansweredMessage('no turn in progress') }
    // 条目在 tool_execution_start 时已经建好并发出去了，那个事件先于这道钩子。
    const call = active.tools.get(ask.toolCallId)
    let reason = kind === 'tool' ? toolReason(ask) : null
    if (kind === 'fileChange') {
      // 标准的文件改动审批不带差异，客户端按条目标识去看条目上的改动：先把差异放上去。
      const preview = previewFileChange(thread.cwd, ask.toolName, ask.input)
      reason = preview.problem
      if (call?.item.type === 'fileChange') {
        call.item.changes = preview.changes
        call.preview = true
        this.store.saveItems(thread.id, active.turn, [call.item])
        this.notify(thread.id, 'item/fileChange/patchUpdated', {
          turnId: active.turn.id,
          itemId: ask.toolCallId,
          changes: preview.changes,
        })
      }
    }
    const request = approvalRequest(
      kind,
      { threadId: thread.id, turnId: active.turn.id, itemId: ask.toolCallId },
      { command: commandOf(ask), cwd: thread.cwd, reason },
    )
    let answer: ApprovalDecision
    try {
      answer = decisionOf(
        await this.waiting(this.approving, thread.id, () =>
          this.requests.send(
            this.targets(active.peer ?? peer, thread.id, false),
            thread.id,
            request.method,
            () => request.params,
            {
              signal: ask.signal,
              replayable: true,
              // “拒绝并附说明”是我们的扩展，只给握手时声明过的连接；别的连接收到标准的那份。
              paramsFor: (target) =>
                this.declared.get(target.id)?.has(EXTENSION.declineWithNote)
                  ? request.paramsWithNote
                  : undefined,
            },
          ),
        ),
      )
    } catch (error) {
      return {
        block: true,
        reason: unansweredMessage(error instanceof Error ? error.message : String(error)),
      }
    }
    if (answer.decision === 'accept' || answer.decision === 'acceptForSession') {
      if (answer.decision === 'acceptForSession') {
        const keys = this.grants.get(thread.id) ?? new Set<string>()
        keys.add(key)
        this.grants.set(thread.id, keys)
      }
      // 等答复可能等了很久：写文件的调用放行之前，把“写之前的内容”重新读一遍。
      if (call && kind === 'fileChange' && ask.toolName === 'write')
        call.before = contentBefore(thread.cwd, call.args.path)
      return undefined
    }
    if (call) call.declined = true
    if (answer.decision === 'cancel') {
      // 取消是连回合一起停。打断要等回合收场，而回合正等着这个函数返回，所以不在这里等它。
      void this.interrupt(thread.id).catch((error) =>
        this.notify(thread.id, 'warning', { message: String(error) }),
      )
      return { block: true, reason: CANCELLED_MESSAGE, terminate: true }
    }
    return { block: true, reason: deniedMessage(answer.note) }
  }
  /**
   * 会话没了（删掉、临时会话卸载）：适配器这边记的全删掉，库里的会话、回合、提交、元数据、项目归属、排队的消息，
   * 连同内存里“以后都允许”的记录；之后按会话号找答“没有这个会话”。
   * 也不再发 thread/closed：删掉的只发 thread/deleted（上游也是），临时会话卸载时已经没有订阅者可发。
   * 原生会话文件和执行会话由调用方处置
   */
  drop(threadId: string): void {
    this.store.db.prepare('DELETE FROM queued_submissions WHERE thread_id=?').run(threadId)
    this.store.db.prepare('DELETE FROM project_threads WHERE thread_id=?').run(threadId)
    this.store.db.prepare('DELETE FROM live_project_threads WHERE thread_id=?').run(threadId)
    this.store.delete(threadId)
    this.grants.delete(threadId)
    this.attached.delete(threadId)
  }
  subscribe(peer: RpcPeer, id: string): void {
    const ids = this.subscriptions.get(id) ?? new Set<string>()
    ids.add(peer.id)
    this.subscriptions.set(id, ids)
    this.attached.add(id)
  }
  notify(threadId: string | null, method: string, params: any): void {
    if (method === 'item/started') params = { startedAtMs: Date.now(), ...params }
    if (method === 'item/completed')
      params = { startedAtMs: null, completedAtMs: Date.now(), ...params }
    // 会话的新建、状态、改名、归档这些和上游一样发给所有连接，没订阅这个会话的客户端靠它们跟着变；
    // 临时会话的除外（客户端起标题用的，不进列表，别的连接拿到只会多出一个列表里没有的会话）
    const everyone =
      threadId === null ||
      (BROADCAST_THREAD_NOTIFICATIONS.has(method) && !this.store.ephemeral(threadId))
    for (const peer of this.peers.values())
      if (everyone || (threadId !== null && this.subscriptions.get(threadId)?.has(peer.id)))
        peer.send({ method, params: threadId ? { threadId, ...params } : params })
  }
  /** 扩展的通知（不属于哪个会话）：只发给握手时声明了这个扩展的连接 */
  notifyExtension(extension: string, method: string, params: any): void {
    for (const peer of this.peers.values())
      if (this.declared.get(peer.id)?.has(extension)) peer.send({ method, params })
  }
  call(
    peer: RpcPeer | undefined,
    threadId: string,
    method: string,
    params: any,
    signal?: AbortSignal,
  ): Promise<any> {
    // 客户端执行的工具调用可能有副作用，只交给一条连接、也不补送给后来订阅的连接。
    const tool = method === 'item/tool/call'
    const turnId = this.active.get(threadId)?.turn.id ?? ''
    let targets: RpcPeer[]
    if (tool && isClientToolNamespace(params.namespace)) {
      // 客户端工具（litch_ 开头的命名空间）只交给声明了它的连接，挑不出来当场失败，不交给别人
      const executor = this.clientToolExecutor(peer, threadId, params.namespace)
      if (!executor) return Promise.resolve(noClientToolExecutor(params.namespace))
      targets = [executor]
    } else targets = this.targets(peer, threadId, tool)
    return this.requests.send(
      targets,
      threadId,
      method,
      // 工具调用的参数照上游的形状（DynamicToolCallParams），不带 itemId
      (id) =>
        tool ? { threadId, turnId, ...params } : { threadId, turnId, itemId: id, ...params },
      { signal, replayable: !tool },
    )
  }
  // 客户端工具的执行方（规矩在 shared/src/client-tool-executor.mts）：发起回合的连接还连着、声明了这个
  // 命名空间就是它；否则订阅着会话、声明了的连接里最早订阅的那条；都没有返回 null
  private clientToolExecutor(
    peer: RpcPeer | undefined,
    threadId: string,
    namespace: string,
  ): RpcPeer | null {
    const starter = (peer && this.peers.get(peer.id)) ?? null
    return pickClientToolExecutor(
      namespace,
      starter,
      this.subscribers(threadId),
      (target) => this.toolNamespaces.get(target.id) ?? new Set(),
    )
  }
  /** 订阅着这个会话、还连着的连接，按订阅的先后 */
  subscribers(threadId: string): RpcPeer[] {
    return [...(this.subscriptions.get(threadId) ?? [])].flatMap((id) => this.peers.get(id) ?? [])
  }
  // 一条请求该发给谁。提问这类只要一个决定的发给全部订阅连接，先答的生效；没人订阅时交给发起回合的连接。
  // 工具调用照旧只交给一条：发起回合的连接还连着就给它，否则给最早订阅的那条。
  private targets(peer: RpcPeer | undefined, threadId: string, single: boolean): RpcPeer[] {
    const initiator = peer && this.peers.get(peer.id)
    const subscribed = this.subscribers(threadId)
    if (single) return [initiator ?? subscribed[0]].flatMap((target) => target ?? [])
    if (subscribed.length) return subscribed
    return initiator ? [initiator] : []
  }
  async index(cwd?: string | string[]): Promise<void> {
    if (this.indexing) return this.indexing
    this.indexing = (async () => {
      const rows = this.store.threads()
      const byPath = new Map(rows.map((t) => [t.path, t]))
      const byId = new Map(rows.map((t) => [t.id, t]))
      for (const directory of sessionIndexDirectories([
        ...(Array.isArray(cwd) ? cwd : [cwd ?? process.cwd()]),
        ...rows.map((t) => t.cwd),
      ]))
        for (const { thread, entries } of await discoverSessions(directory, this.nativeFiles)) {
          const old = byPath.get(thread.path) ?? byId.get(thread.id)
          if (old && this.active.has(old.id)) continue
          if (old && thread.path && this.indexed.get(thread.path) === entries) continue
          if (old) {
            thread.id = old.id
            thread.dynamicTools = old.dynamicTools
            thread.forkedFromId = old.forkedFromId
          }
          this.store.saveThread(thread)
          this.store.replaceTurns(thread.id, projectHistory(nativeBranch(entries), thread))
          if (thread.path) this.indexed.set(thread.path, entries)
        }
    })()
    try {
      await this.indexing
    } finally {
      this.indexing = null
    }
  }
  // prepared 只在线程还没有执行会话时使用：分叉把刚建好的原生会话直接交给执行会话，
  // 临时会话（新建的、分叉出来的）把建在内存里的会话交进来。
  async load(
    thread: PiThread,
    peer: RpcPeer,
    refresh = false,
    prepared?: SessionManager,
  ): Promise<LiveSession> {
    const pending = this.loading.get(thread.id)
    if (pending) return this.synchronize(thread, await pending)
    const loading = (async () => {
      await this.releasing.get(thread.id)
      return this.open(thread, peer, refresh, prepared)
    })()
    this.loading.set(thread.id, loading)
    try {
      return await loading
    } finally {
      this.loading.delete(thread.id)
    }
  }
  private async open(
    thread: PiThread,
    peer: RpcPeer,
    refresh: boolean,
    prepared?: SessionManager,
  ): Promise<LiveSession> {
    const cached = this.sessions.get(thread.id)
    // 临时会话只在内存里，执行会话就是它的全部：没有了（卸载了，正在卸载）就是没了，不能另建一个空的顶替，
    // 照上游答“没有这个会话”
    if (thread.ephemeral && !cached && !prepared) throw new ThreadNotFound(thread.id)
    if (
      !thread.ephemeral &&
      thread.path &&
      !existsSync(thread.path) &&
      this.store.turns(thread.id).some((t) => t.items.length)
    )
      throw new ProtocolError(-32009, 'Pi 原生会话文件已移除，无法继续恢复')
    if (cached && (!refresh || !thread.path || !existsSync(thread.path)))
      return this.synchronize(thread, cached)
    if (cached && thread.path) {
      const disk = this.nativeFiles.read(thread.path).slice(1)
      if (JSON.stringify(disk) === JSON.stringify(cached.session.sessionManager.getEntries()))
        return this.synchronize(thread, cached)
    }
    if (cached) {
      await cached.dispose()
      this.sessions.delete(thread.id)
    }
    const reverse = (method: string, params: any, signal?: AbortSignal) => {
      const target = this.active.get(thread.id)?.peer ?? peer
      return method === 'item/tool/requestUserInput'
        ? this.ask(target, thread.id, params, signal)
        : this.call(target, thread.id, method, params, signal)
    }
    // 计划插件交了计划之后问不问（就绪菜单）：看发起这个回合的连接握手时声明了 planConfirmation 没有，
    // 没声明的（官方桌面端）在回合结束后自己问（ui.mts 的 asksPlan）
    const asksPlan = () =>
      this.declared
        .get((this.active.get(thread.id)?.peer ?? peer).id)
        ?.has(EXTENSION.planConfirmation) === true
    const live = await openSession(
      thread,
      {
        ui: createUi(
          reverse,
          (method, params) => {
            if (method === 'warning') this.active.get(thread.id)?.notices?.push(params.message)
            this.notify(thread.id, method, params)
          },
          asksPlan,
        ),
        emit: (event) => onEvent(this, thread, event),
        tool: (tool, args, id, signal) =>
          reverse(
            'item/tool/call',
            { callId: id, namespace: tool.namespace, tool: tool.name, arguments: args },
            signal,
          ),
        // 没打开审批时不给这一项：Pi 那边不挂钩子，和以前一样什么都不问。
        ...(this.approvals
          ? { approve: (ask: ToolCallAsk) => this.approve(peer, thread, ask) }
          : {}),
      },
      prepared,
    )
    this.sessions.set(thread.id, live)
    return this.synchronize(thread, live)
  }
  private synchronize(thread: PiThread, live: LiveSession): LiveSession {
    thread.path = live.session.sessionFile ?? null
    thread.name = live.session.sessionName ?? null
    thread.model = live.session.model
      ? `${live.session.model.provider}/${live.session.model.id}`
      : null
    thread.effort = live.session.thinkingLevel
    thread.planMode = Boolean(planState(live.session).enabled)
    this.store.saveThread(thread)
    if (
      !this.active.has(thread.id) &&
      live.session.sessionManager.getEntries().some((e) => e.type === 'message')
    )
      this.store.replaceTurns(
        thread.id,
        projectHistory(live.session.sessionManager.getBranch(), thread),
      )
    return live
  }
  envelope(thread: PiThread, includeTurns = true, byId?: Map<string, PiThread>): any {
    const ancestors = thread.parentThreadId ? this.ancestors(thread, byId) : []
    const metadata = this.store.getMeta('thread', thread.id) ?? {}
    return {
      id: thread.id,
      sessionId: thread.id,
      // 经 thread/fork 分出来的记着会话号；Pi 自己分出来的只有上级的文件路径，按路径换，上级不在这里的是 null
      forkedFromId:
        thread.forkedFromId ??
        (thread.forkedFromPath ? this.store.threadAt(thread.forkedFromPath) : null),
      preview: thread.preview,
      name: thread.name,
      modelProvider: thread.model?.split('/')[0] ?? 'pi',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      historyMode: metadata.historyMode ?? 'legacy',
      threadSource: thread.parentThreadId ? 'subagent' : 'user',
      section:
        metadata.sectionId === PINNED_SECTION_ID
          ? PINNED_SECTION
          : metadata.sectionId
            ? (this.store.getMeta('section', metadata.sectionId) ?? null)
            : null,
      sectionEnteredAt: metadata.sectionEnteredAt ?? null,
      isPinned: metadata.sectionId === PINNED_SECTION_ID,
      canAcceptDirectInput: true,
      activePermissionProfile: ':danger-full-access',
      status: this.status(thread.id),
      // 原生 Pi JSONL 不是 Codex rollout；只在引擎内部使用，不能交给桌面读取。
      path: null,
      cwd: thread.cwd,
      cliVersion: '0.99.1',
      source: thread.parentThreadId
        ? {
            subAgent: {
              thread_spawn: { parent_thread_id: thread.parentThreadId, depth: ancestors.length },
            },
          }
        : 'appServer',
      parentThreadId: thread.parentThreadId ?? null,
      ephemeral: thread.ephemeral,
      gitInfo: null,
      agentNickname: null,
      agentRole: null,
      turns: includeTurns ? this.store.turns(thread.id) : [],
      projectId: this.projects.projectId(thread.id),
      ...metadata,
    }
  }
  ancestors(
    thread: PiThread,
    byId = new Map(this.store.threads().map((row) => [row.id, row])),
  ): string[] {
    const ancestors: string[] = []
    const seen = new Set([thread.id])
    let parent = thread.parentThreadId
    while (parent && !seen.has(parent)) {
      ancestors.push(parent)
      seen.add(parent)
      parent = byId.get(parent)?.parentThreadId
    }
    return ancestors
  }
  settings(thread: PiThread): any {
    return {
      thread: this.envelope(thread),
      model: thread.model ?? '',
      modelProvider: thread.model?.split('/')[0] ?? 'pi',
      cwd: thread.cwd,
      // 打开审批后只读的工具照旧直接用，其余的都先问：最接近协议里的 untrusted。
      approvalPolicy: this.approvals ? 'untrusted' : 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'dangerFullAccess' },
      sandboxPolicy: { type: 'dangerFullAccess' },
      reasoningEffort: thread.effort,
      collaborationMode: {
        mode: thread.planMode ? 'plan' : 'default',
        settings: {
          model: thread.model ?? '',
          reasoning_effort: thread.effort,
          developer_instructions: null,
        },
      },
    }
  }
  start(peer: RpcPeer, thread: PiThread, params: any): PiTurn {
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    const input = {
      input: params.input,
      collaborationMode: params.collaborationMode,
      model: params.model,
    }
    const existing = clientId ? this.store.submitted(thread.id, clientId, input) : null
    if (existing) return existing
    if (params.outputSchema != null) throw new ProtocolError(-32602, 'Pi 首期不支持严格结构化输出')
    this.ensureIdle(thread.id)
    const active = this.admit(peer, thread, params, clientId, input)
    // 头一句话在回合开始时就记下（上游记下第一条用户消息就落盘）：第一个回合进行中读会话、列会话就有预览。
    // 上游这时不另发通知，这里也不发
    if (!thread.preview && Array.isArray(params.input)) {
      thread.preview = inputPreview(params.input)
      this.store.saveThread(thread)
    }
    setImmediate(() => void runTurn(this, active, params))
    return active.turn
  }
  /** 会话这时开不了回合就报错：已经有回合在跑、Pi 还没闲下来、扩展还有要交的输入 */
  ensureIdle(threadId: string): void {
    if (
      this.active.has(threadId) ||
      this.sessions.get(threadId)?.session.isIdle === false ||
      this.sessions.get(threadId)?.hasPendingInputs()
    )
      throw new ProtocolError(-32009, '会话已有活动回合')
  }
  /**
   * 开一个回合：记进库（连同提交的账）、标成在跑、发起的连接订阅这个会话。开不开得了调用方先查过（ensureIdle）；
   * 回合里做什么也由调用方定：发消息是 runTurn，手动压缩是 compaction.mts（Pi 这时已经在压了，不算闲着）
   */
  admit(
    peer: RpcPeer,
    thread: PiThread,
    params: any,
    clientId: any = null,
    input: unknown = null,
  ): ActiveTurn {
    const turn: PiTurn = {
      id: `codex-harness-adapter:${randomUUID()}`,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    }
    let resolve = () => {}
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const active: ActiveTurn = {
      thread,
      turn,
      peer,
      stopped: false,
      tools: new Map(),
      done,
      resolve,
      pending: [
        { clientId, input: Array.isArray(params.input) ? inputRecord(params.input) : null },
      ],
      notices: [],
    }
    this.store.admit(
      thread.id,
      clientId,
      input,
      turn,
      params.queuedSubmissionId
        ? () => this.queue.consume(thread.id, params.queuedSubmissionId, clientId, params.input)
        : undefined,
    )
    this.active.set(thread.id, active)
    this.subscribe(peer, thread.id)
    return active
  }
  async interrupt(id: string): Promise<void> {
    const active = this.active.get(id)
    this.store.setMeta('queue', id, { paused: true })
    if (active) active.stopped = true
    this.requests.reject((threadId) => threadId === id, '回合已停止')
    active?.live?.session.clearQueue()
    await active?.live?.session.abort()
    await active?.done
    const live = this.sessions.get(id)
    // 别的会话丢掉执行会话，下次照原生会话文件重新载入；临时会话只在内存里，这一份就是它的全部，留着接着用
    if (live && !this.store.ephemeral(id)) {
      await live.dispose()
      this.sessions.delete(id)
      this.background.delete(id)
    }
  }
  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.declared.delete(peer.id)
    this.toolNamespaces.delete(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    // 订阅者断开只摘掉它自己：别的连接还拿着的请求继续等，一条都不剩的才结束。
    this.requests.dropPeer(peer.id, '客户端已断开')
    void this.releaseUnused().catch(() => {})
  }
  async releaseUnused(): Promise<void> {
    if (this.closing) return
    for (const [id, live] of this.sessions) {
      if (
        this.subscriptions.get(id)?.size ||
        this.active.has(id) ||
        !live.session.isIdle ||
        live.hasPendingInputs() ||
        this.background.get(id)?.size ||
        this.loading.has(id) ||
        this.releasing.has(id) ||
        this.locks.has(id)
      )
        continue
      const releasing = live.dispose().finally(() => {
        if (this.sessions.get(id) === live) this.sessions.delete(id)
        this.releasing.delete(id)
        this.background.delete(id)
        // 临时会话卸载了就没了（上游卸载临时会话也是，没有可以重新载入的记录）：库里的记录一起删掉
        if (this.store.ephemeral(id)) this.drop(id)
      })
      this.releasing.set(id, releasing)
      await releasing
    }
    await Promise.all(this.releasing.values())
    this.closeUnused()
  }
  /**
   * 照上游发 thread/closed：上游在会话没有订阅者、也不在跑了一阵之后卸载它（thread_lifecycle.rs，默认等 60 秒），
   * 发给所有连接；这里对应的是原生会话释放了（releaseUnused 当场释放，不等），或者被打断时已经丢掉了。
   * 只发给有过订阅者的：为改名这类事临时载入、从没被订阅过的，客户端不知道它被载入过。
   */
  private closeUnused(): void {
    for (const id of this.attached)
      if (
        !this.subscriptions.get(id)?.size &&
        !this.sessions.has(id) &&
        !this.active.has(id) &&
        !this.loading.has(id) &&
        !this.releasing.has(id)
      ) {
        this.attached.delete(id)
        this.notify(id, 'thread/closed', {})
      }
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.loading.values())
    await Promise.allSettled(this.releasing.values())
    for (const id of this.active.keys()) await this.interrupt(id)
    for (const live of this.sessions.values()) await live.dispose()
    this.sessions.clear()
    this.files.close()
    await this.processes.close()
    this.store.close()
  }
}
