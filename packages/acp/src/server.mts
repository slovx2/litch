import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  type BackgroundReport,
  notificationWithOrigin,
} from '../../shared/src/background-report.mjs'
import {
  BackgroundShells,
  backgroundShellEnabled,
  formatShellEvent,
  type ShellTask,
  withStopNotice,
} from '../../shared/src/background-shell.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
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
import { sleep } from '../../shared/src/util.mjs'
import { type AcpAgentId, agentId, BACKGROUND_SHELL_AGENTS } from './agent.mjs'
import { requestPermission } from './approvals.mjs'
import {
  type Catalog,
  currentEffort,
  currentMode,
  currentModel,
  efforts,
  models,
  modes,
  planMode,
  setEffort,
  setMode,
  setModel,
} from './catalog.mjs'
import { readTextFile, Terminals, writeTextFile } from './client-side.mjs'
import { ClientTools } from './client-tools.mjs'
import { AcpError, HandlerError } from './connection.mjs'
import { settings } from './envelope.mjs'
import { type AcpThread, type AcpTurn, Projection } from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { AcpRuntime, type AgentHandle } from './runtime.mjs'
import { AcpStore } from './store.mjs'
import { echoContent, promptContent, withStopNoticeBlocks } from './turn.mjs'

// 调试用：CHA_ACP_TRACE 指向文件时逐行记录与客户端往来的协议消息，默认关闭。
const tracePath = process.env.CHA_ACP_TRACE
const trace = (direction: 'in' | 'out', message: unknown) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ direction, message })}\n`)
}

const EPHEMERAL_PREFIX = 'ephemeral-'
/** 回合被打断时撤回挂着的审批用的原因 */
export const TURN_STOPPED = '回合已停止'

/** 打断之后等 agent 回 session/prompt 的时限，到点由适配器收尾 */
const INTERRUPT_WAIT_MS = 10_000

export interface LiveThread {
  projection: Projection
  /** 会话在第几个 agent 进程里接上了（runtime.mts 的 generation）；0 是还没接上 */
  generation: number
  /** 换了、还没交给 agent 的设置：下一回合开始前交 */
  pending: { model: string | null; effort: string | null; mode: 'plan' | 'default' | null }
  /** 本进程里受理过的提交标识：同一条消息再发一遍回的是同一个回合 */
  submitted: Map<string, AcpTurn>
  /** 进行中的回合：提示词交没交给 agent、有没有被打断，done 在回合收尾（不管成败）时兑现 */
  running: Running | null
  /** 进计划模式之前的模式，出计划模式时换回去 */
  previousMode: string | null
  /** 发起当前回合的连接：客户端工具的调用先交给它（client-tools.mts） */
  starter: { turnId: string; peerId: string } | null
}

interface Running {
  turn: AcpTurn
  sent: boolean
  stopped: boolean
  done: Promise<void>
}

/** 适配器库里记的会话摘要（经这个入口建过、打开过的会话） */
interface SessionRecord {
  id: string
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  forkedFromId: string | null
  /** 起过回合：没说过话的会话不进线程列表 */
  spoken: boolean
  userNamed: boolean
}

export class AcpServer {
  readonly agentId: AcpAgentId
  readonly store: AcpStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly live = new Map<string, LiveThread>()
  // 临时线程（客户端生成标题、摘要时用）：只在内存里，没有 agent 会话，无人订阅即卸载。
  readonly ephemeral = new Map<string, LiveThread>()
  readonly runtime: AcpRuntime
  readonly terminals: Terminals
  /** 动态工具（含 Litch 的客户端工具）：按会话挂给 agent 的 MCP 桥 */
  readonly clientTools: ClientTools
  /**
   * 注入的后台 shell（shared/src/background-shell.mts）：只给通用入口 acp（gemini、qwen 有自己的，不带），
   * 设置 harness.acp.backgroundShell 关着时是 null。进程归这个运行时，运行时退出时一起结束
   */
  readonly shells: BackgroundShells | null
  /** 后台任务的集合、回合的来历怎么加到给声明过 backgroundTasks 的连接的应答和通知上 */
  readonly report: BackgroundReport
  /** 各连接握手时声明认识的扩展：服务端主动给的扩展内容只发给声明过的连接 */
  readonly declared = new Map<string, Set<string>>()
  private closed = false
  private readonly loading = new Map<string, Promise<LiveThread>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  // 正在 session/load 回放的会话：这期间的更新归到这里
  private readonly replays = new Map<string, Projection>()
  // agent 的会话清单，最近一次问来的（见 sessions）
  known = new Map<string, AcpThread>()
  // 问过技能清单的连接：命令清单变了给它们发 skills/changed
  private readonly skillPeers = new Map<string, RpcPeer>()
  // 发给客户端并等回答的请求（审批）：发给会话的全部订阅连接，先答的生效。
  private readonly requests = new ServerRequests((threadId, method, params) =>
    this.notify(threadId, method, params),
  )

  constructor(home: string, env: NodeJS.ProcessEnv = process.env) {
    this.agentId = agentId(env)
    this.store = new AcpStore(home)
    this.projects = new ProjectStore(this.store.db, {
      find: (id) => this.thread(id),
      recency: (ids) => {
        const times = ids.flatMap((id) => {
          const thread = this.thread(id)
          const archived = this.store.getMeta('thread', id)?.archived === true
          return thread && !thread.ephemeral && !archived ? [thread.updatedAt] : []
        })
        return times.length ? Math.max(...times) : null
      },
    })
    this.queue = new QueueStore(this.store.db)
    this.terminals = new Terminals((sessionId, terminalId, delta) =>
      this.live
        .get(sessionId)
        ?.projection.terminalOutput(terminalId, delta, (method, params) =>
          this.notify(sessionId, method, params),
        ),
    )
    this.shells =
      BACKGROUND_SHELL_AGENTS.has(this.agentId) && backgroundShellEnabled(env)
        ? new BackgroundShells(join(home, 'background-shell'), {
            changed: (threadId) => this.publishBackground(threadId),
            finished: (threadId, tasks) =>
              void this.wake(threadId, tasks).catch((error) =>
                this.notify(threadId, 'warning', {
                  message: `后台命令结束后没能叫醒 ${this.agentName()}：${error instanceof Error ? error.message : String(error)}`,
                }),
              ),
          })
        : null
    this.report = {
      declared: (peerId) => this.declared.get(peerId)?.has(EXTENSION.backgroundTasks) === true,
      tasks: (threadId) => this.shells?.collection(threadId) ?? [],
      origin: (threadId, turnId) => this.live.get(threadId)?.projection.origins.get(turnId),
      wakes: true,
    }
    this.clientTools = new ClientTools(this)
    this.runtime = new AcpRuntime(
      home,
      {
        request: (method, params, agent) => this.agentRequest(method, params, agent),
        notification: (method, params, agent) => this.agentNotification(method, params, agent),
        closed: (error, agent) => this.agentClosed(error, agent),
      },
      env,
    )
  }

  /** 已知的会话：打开着的、库里记着的、agent 清单里有的 */
  thread(id: string): AcpThread | null {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    if (loaded) return loaded.projection.thread
    const record = this.record(id)
    return record ? threadOf(record) : (this.known.get(id) ?? null)
  }

  record(id: string): SessionRecord | null {
    return this.store.getMeta('session', id)
  }

  /** 会话摘要记进库里：打开着的照内存里的写 */
  save(live: LiveThread, spoken?: boolean): void {
    const { thread, userNamed } = live.projection
    if (thread.ephemeral) return
    const before = this.record(thread.id)
    const record: SessionRecord = {
      id: thread.id,
      cwd: thread.cwd,
      name: thread.name,
      preview: thread.preview,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      forkedFromId: thread.forkedFromId,
      spoken: spoken ?? before?.spoken ?? false,
      userNamed,
    }
    if (JSON.stringify(before) !== JSON.stringify(record))
      this.store.setMeta('session', thread.id, record)
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
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
      this.requests.answer(peer, message as any)
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ id: message.id, result } as any)
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32603
      const text = error instanceof Error ? error.message : String(error)
      // 会话不在这里不记：那是正常的应答（官方桌面端找置顶会话在哪台机器上时，拿别处的会话号向每个入口都问）
      if (!(error instanceof ThreadNotFound))
        console.error(`[${this.agentId}] ${message.method} 失败（${code}）: ${text}`)
      peer.send({ id: message.id, error: { code, message: text } } as any)
    } finally {
      // 这次请求可能让这条连接订阅了某个会话：把还在等人回答的请求补送给它
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
    // 会话的新建、状态、改名、归档这些和上游一样发给所有连接；临时线程的除外
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
    const params = { threadId, tasks: this.report.tasks(threadId), wakesOnFinish: true }
    for (const peer of this.peers.values())
      if (this.report.declared(peer.id))
        peer.send({ method: BACKGROUND_TASKS_NOTIFICATION.changed, params })
  }

  /** 订阅着这个线程、还连着的连接，按订阅的先后 */
  subscribers(threadId: string): RpcPeer[] {
    return [...(this.subscriptions.get(threadId) ?? [])].flatMap((id) => this.peers.get(id) ?? [])
  }

  /** 只发给 targets 的反向请求（动态工具的调用）：有副作用，不补送给后来订阅的连接 */
  askClient(
    targets: RpcPeer[],
    threadId: string,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<any> {
    return this.requests.send(targets, threadId, method, () => params, {
      signal,
      replayable: false,
    })
  }

  // 向订阅了该线程的全部客户端发起反向请求（审批），先答的生效；signal 中止时撤回。
  call(threadId: string, method: string, params: any, signal?: AbortSignal): Promise<any> {
    return this.requests.send(
      this.subscribers(threadId),
      threadId,
      method,
      () => ({ threadId, turnId: this.live.get(threadId)?.projection.active?.id ?? '', ...params }),
      { signal, replayable: true },
    )
  }

  // ---------- 发给 agent ----------

  /** 向 agent 发请求；agent 回的错误换成协议错误，带上是哪个 agent 说的 */
  async ask(agent: AgentHandle, method: string, params: unknown): Promise<any> {
    try {
      return await agent.connection.request(method, params)
    } catch (error) {
      throw this.failure(agent, error)
    }
  }

  private failure(agent: AgentHandle, error: unknown): ProtocolError {
    if (error instanceof ProtocolError) return error
    const name = agent.resolved.spec.displayName
    if (!(error instanceof AcpError))
      return new ProtocolError(-32603, error instanceof Error ? error.message : String(error))
    // ACP 的 -32000 是“要先登录”：适配器不代为登录（会弹浏览器、要用户的账号），请用户在终端里登一次
    if (error.code === -32000) {
      const methods = (agent.caps.authMethods ?? [])
        .map((method: any) => method?.name ?? method?.id)
        .filter(Boolean)
        .join('、')
      return new ProtocolError(
        -32600,
        `${name} 需要先登录：请在终端里运行它完成登录${methods ? `（它支持：${methods}）` : ''}。原话：${error.message}`,
      )
    }
    const code = error.code === -32602 || error.code === -32601 ? error.code : -32603
    return new ProtocolError(code, `${name}：${error.message}`)
  }

  // ---------- agent 那边来的 ----------

  // 还没对上会话的更新（session/new 的应答之前就到了的那几条），会话建好后补上
  private readonly early = new Map<string, any[]>()

  private agentNotification(method: string, params: any, agent: AgentHandle): void {
    if (method !== 'session/update') return
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
    if (!sessionId) return
    const scratch = this.replays.get(sessionId)
    if (scratch) {
      scratch.update(params.update, () => {})
      return
    }
    const live = this.live.get(sessionId)
    if (!live || live.generation !== agent.generation) {
      const queued = this.early.get(sessionId) ?? []
      if (queued.length < 50) queued.push(params.update)
      this.early.set(sessionId, queued)
      return
    }
    this.apply(live, params.update)
  }

  private apply(live: LiveThread, update: unknown): void {
    const id = live.projection.thread.id
    const change = live.projection.update(update, (method, params) =>
      this.notify(id, method, params),
    )
    if (change === 'settings') {
      this.saveCatalog(live)
      this.notify(id, 'thread/settings/updated', { threadSettings: settings(this, live) })
    } else if (change === 'commands') {
      this.store.setMeta('commands', live.projection.thread.cwd, live.projection.commands)
      for (const peer of this.skillPeers.values())
        peer.send({ method: 'skills/changed', params: {} } as any)
    } else if (change === 'name') {
      this.save(live)
      this.notify(id, 'thread/name/updated', { threadName: live.projection.thread.name })
    }
  }

  private async agentRequest(method: string, params: any, agent: AgentHandle): Promise<unknown> {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    const live = this.live.get(sessionId)
    const attached = live && live.generation === agent.generation ? live : null
    const notify = (name: string, value: any) => this.notify(sessionId, name, value)
    switch (method) {
      case 'session/request_permission': {
        // 回放、或者会话不在这里打开着：没有人能答，当取消
        if (!attached) return { outcome: { outcome: 'cancelled' } }
        // 调的是会话的动态工具：不经 agent 的审批（同 client-tools.json 的规矩，要不要问用户由执行方定），
        // 允许这一次（“总是允许”有的 agent 会写进用户自己的配置）
        const once = (Array.isArray(params?.options) ? params.options : []).find(
          (option: any) => option?.kind === 'allow_once',
        )
        if (once && this.clientTools.detect(sessionId, params?.toolCall)) {
          if (attached.projection.active) attached.projection.ensureTool(params.toolCall, notify)
          return { outcome: { outcome: 'selected', optionId: once.optionId } }
        }
        return requestPermission(this, attached, params, new AbortController().signal)
      }
      case 'fs/read_text_file':
        return readTextFile(params)
      case 'fs/write_text_file': {
        const written = await writeTextFile(params)
        attached?.projection.fileWritten(written.path, written.before, written.after, notify)
        return null
      }
      case 'terminal/create':
        return this.terminals.create(params)
      case 'terminal/output':
        return this.terminals.output(params)
      case 'terminal/wait_for_exit':
        return this.terminals.waitForExit(params)
      case 'terminal/kill':
        return this.terminals.kill(params)
      case 'terminal/release':
        return this.terminals.release(params)
      default:
        throw new HandlerError(-32601, `Method not found: ${method}`)
    }
  }

  // agent 进程退出了：在跑的回合按失败收尾，会话都要重新接上（下一回合时，见 attach）
  private agentClosed(error: Error, agent: AgentHandle): void {
    void this.terminals.closeAll()
    for (const [id, live] of this.live) {
      if (live.generation !== agent.generation) continue
      live.generation = 0
      this.requests.reject((threadId) => threadId === id, error.message)
      if (live.projection.active) {
        live.projection.finish(
          { error: `${agent.resolved.spec.displayName} 进程已退出：${error.message}` },
          (method, params) => this.notify(id, method, params),
        )
        this.saveTurns(live)
      }
    }
  }

  // ---------- 会话的打开、接上 ----------

  private fresh(thread: AcpThread): LiveThread {
    const projection = new Projection(thread, (text) => this.recall(thread.id, text))
    projection.terminalSoFar = (terminalId) => this.terminals.soFar(terminalId)
    projection.server = this.agentId
    projection.dynamicTool = (toolCall) => this.clientTools.detect(thread.id, toolCall)
    projection.toolAdded = () => this.clientTools.wake()
    return {
      projection,
      generation: 0,
      pending: { model: null, effort: null, mode: null },
      submitted: new Map(),
      running: null,
      previousMode: null,
      starter: null,
    }
  }

  /** 打开会话（不订阅）。打开着的直接给；库里记着的照库里的摆回来，不起 agent；agent 清单里有的用 session/load 回放 */
  load(id: string): Promise<LiveThread> {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    if (loaded) return Promise.resolve(loaded)
    if (id.startsWith(EPHEMERAL_PREFIX)) return Promise.reject(new ThreadNotFound(id))
    const loading =
      this.loading.get(id) ??
      this.open(id).finally(() => {
        this.loading.delete(id)
      })
    this.loading.set(id, loading)
    return loading
  }

  private async open(id: string): Promise<LiveThread> {
    const record = this.record(id)
    if (record) {
      const live = this.fresh(threadOf(record))
      live.projection.userNamed = record.userNamed
      live.projection.restore(
        this.store.getMeta('turns', id) ?? [],
        this.store.getMeta('turnOrigins', id) ?? {},
      )
      Object.assign(live.projection, this.store.getMeta('catalog', id) ?? {})
      live.projection.commands = this.store.getMeta('commands', record.cwd) ?? []
      this.live.set(id, live)
      return live
    }
    // 不是经这里建的会话：只认 agent 清单里有的（别的 harness 的会话号不为它去起 agent）
    let listed = this.known.get(id)
    if (!listed && this.runtime.current()?.caps.list) {
      await this.sessions().catch(() => [])
      listed = this.known.get(id)
    }
    if (!listed) throw new ThreadNotFound(id)
    const agent = await this.runtime.agent()
    const live = this.fresh({ ...listed })
    if (agent.caps.loadSession) {
      // 回放出历史；回放完会话就在这个 agent 进程里接上了
      const response = await this.replay(agent, live.projection, [])
      this.catalogFrom(live, response)
      live.generation = agent.generation
    }
    live.projection.commands = this.store.getMeta('commands', listed.cwd) ?? []
    this.live.set(id, live)
    return live
  }

  // session/load：agent 把历史以 session/update 一条条发回来，回放进 projection
  private async replay(
    agent: AgentHandle,
    projection: Projection,
    mcpServers: unknown[],
  ): Promise<any> {
    const { id, cwd } = projection.thread
    projection.startReplay()
    this.replays.set(id, projection)
    try {
      return await this.ask(agent, 'session/load', { sessionId: id, cwd, mcpServers })
    } finally {
      this.replays.delete(id)
      projection.endReplay()
    }
  }

  /**
   * 会话要在现在这个 agent 进程里接上（发提示词、改设置之前）。进程换过的：有 session/resume 的接回去，
   * 只有 session/load 的回放一遍（历史以适配器记的为准，回放的丢掉），都没有的接不上。
   */
  async attach(live: LiveThread): Promise<AgentHandle> {
    let agent: AgentHandle
    try {
      agent = await this.runtime.agent()
    } catch (error) {
      throw new ProtocolError(-32603, error instanceof Error ? error.message : String(error))
    }
    if (live.generation === agent.generation) return agent
    const { thread } = live.projection
    // 会话的动态工具每次接上都要重新挂（新的 agent 进程里没有上一次的 MCP 服务）
    const { servers } = await this.clientTools.mount(thread.id, this.clientTools.raw(thread.id))
    let response: any
    if (agent.caps.resume)
      response = await this.ask(agent, 'session/resume', {
        sessionId: thread.id,
        cwd: thread.cwd,
        mcpServers: servers,
      })
    else if (agent.caps.loadSession)
      response = await this.replay(agent, this.fresh({ ...thread }).projection, servers)
    else
      throw new ProtocolError(
        -32600,
        `${agent.resolved.spec.displayName} 不支持接回旧会话（没有 session/resume，也没有 session/load）。它的进程重启过，这个会话不能再继续，请新建会话`,
      )
    this.catalogFrom(live, response)
    live.generation = agent.generation
    for (const update of this.early.get(thread.id) ?? []) this.apply(live, update)
    this.early.delete(thread.id)
    return agent
  }

  /** session/new、load、resume、fork 的应答里带的模型、模式、配置项 */
  private catalogFrom(live: LiveThread, response: any): void {
    const { projection } = live
    if (Array.isArray(response?.configOptions)) projection.configOptions = response.configOptions
    if (response?.models && Array.isArray(response.models.availableModels))
      projection.models = response.models
    if (response?.modes && Array.isArray(response.modes.availableModes))
      projection.modes = response.modes
    this.saveCatalog(live)
  }

  private saveCatalog(live: LiveThread): void {
    const { projection } = live
    if (projection.thread.ephemeral) return
    const catalog = {
      configOptions: projection.configOptions,
      models: projection.models,
      modes: projection.modes,
    }
    if (!catalog.configOptions && !catalog.models && !catalog.modes) return
    this.store.setMeta('catalog', projection.thread.id, catalog)
    // 最近一次见到的：还没有会话时 model/list、config/read 照它报
    this.store.setMeta('catalog', '', catalog)
  }

  /** 报模型清单用的那一份：打开着的会话里最近的，没有就是库里最近一次见到的 */
  latestCatalog(): Catalog | null {
    const opened = [...this.live.values()]
      .filter((live) => live.projection.configOptions || live.projection.models)
      .sort((a, b) => b.projection.thread.updatedAt - a.projection.thread.updatedAt)[0]
    return opened?.projection ?? this.store.getMeta('catalog', '') ?? null
  }

  saveTurns(live: LiveThread): void {
    if (live.projection.thread.ephemeral) return
    this.store.setMeta('turns', live.projection.thread.id, live.projection.snapshot())
    const { origins } = live.projection
    if (origins.size)
      this.store.setMeta('turnOrigins', live.projection.thread.id, Object.fromEntries(origins))
  }

  // 客户端发来的输入记一份，按会话和交给 agent 的那段文字：session/load 回放出的用户消息是 agent 收到的样子，
  // 照这一份换回客户端发来的样子（技能、提到的文件、提交标识）
  remember(threadId: string, text: string, input: any[], clientId: string | null): void {
    this.store.setMeta('input', `${threadId}:${digest(text)}`, {
      content: echoContent(input),
      clientId,
    })
  }

  private recall(
    threadId: string,
    text: string,
  ): { content: any[]; clientId: string | null } | null {
    return this.store.getMeta('input', `${threadId}:${digest(text)}`) ?? null
  }

  // ---------- 会话清单、新建、分叉 ----------

  /**
   * 线程列表：agent 的会话清单（有 session/list 才问，翻完所有页）并上适配器库里记的。
   * 经这里建了、一句话都没说过的会话不列（和上游一样，没有内容的会话不进列表）。
   */
  async sessions(): Promise<AcpThread[]> {
    // 握过手、知道它不能列会话的，不为列清单去起它
    const known = this.runtime.known
    const agent = known && !known.list ? null : await this.runtime.agent().catch(() => null)
    if (agent?.caps.list) {
      const known = new Map<string, AcpThread>()
      let cursor: string | null = null
      for (let page = 0; page < 100; page++) {
        const response: any = await this.ask(agent, 'session/list', cursor ? { cursor } : {})
        for (const entry of Array.isArray(response?.sessions) ? response.sessions : []) {
          if (typeof entry?.sessionId !== 'string') continue
          const updated = Date.parse(String(entry.updatedAt ?? ''))
          const time = Number.isFinite(updated) ? Math.floor(updated / 1000) : 0
          const title = typeof entry.title === 'string' && entry.title ? entry.title : null
          known.set(entry.sessionId, {
            id: entry.sessionId,
            cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
            name: title,
            preview: title ?? '',
            createdAt: time,
            updatedAt: time,
            forkedFromId: null,
            ephemeral: false,
          })
        }
        cursor =
          typeof response?.nextCursor === 'string' && response.nextCursor
            ? response.nextCursor
            : null
        if (!cursor) break
      }
      this.known = known
    }
    const rows = new Map<string, AcpThread>()
    for (const [id, thread] of this.known) rows.set(id, thread)
    for (const record of this.store.listMeta('session') as SessionRecord[]) {
      if (record.spoken) rows.set(record.id, threadOf(record))
      else rows.delete(record.id)
    }
    for (const [id, live] of this.live)
      if (rows.has(id) || this.record(id)?.spoken) rows.set(id, live.projection.thread)
    return [...rows.values()]
  }

  /** thread/start：agent 那边建一个会话（session/new），在这个进程里接上；带了动态工具的挂上 MCP 桥 */
  async create(cwd: string, dynamicTools: unknown): Promise<LiveThread> {
    const agent = await this.attachable()
    const { servers, key } = await this.clientTools.mount(null, dynamicTools)
    const response = await this.ask(agent, 'session/new', { cwd, mcpServers: servers }).catch(
      (error) => {
        this.clientTools.bind(key, null)
        throw error
      },
    )
    if (typeof response?.sessionId !== 'string') {
      this.clientTools.bind(key, null)
      throw new ProtocolError(
        -32603,
        `${agent.resolved.spec.displayName} 的 session/new 没有回会话号`,
      )
    }
    this.clientTools.bind(key, response.sessionId)
    this.clientTools.remember(response.sessionId, dynamicTools)
    const now = Math.floor(Date.now() / 1000)
    const live = this.fresh({
      id: response.sessionId,
      cwd,
      name: null,
      preview: '',
      createdAt: now,
      updatedAt: now,
      forkedFromId: null,
      ephemeral: false,
    })
    live.generation = agent.generation
    this.catalogFrom(live, response)
    live.projection.commands = this.store.getMeta('commands', cwd) ?? []
    this.live.set(live.projection.thread.id, live)
    this.save(live)
    for (const update of this.early.get(response.sessionId) ?? []) this.apply(live, update)
    this.early.delete(response.sessionId)
    return live
  }

  /** thread/fork：只从会话末尾分（ACP 的 session/fork 不带位置），已经结束的回合照抄过去 */
  async fork(source: LiveThread): Promise<LiveThread> {
    const agent = await this.attachable()
    if (!agent.caps.fork)
      throw new ProtocolError(
        -32004,
        `${agent.resolved.spec.displayName} 不支持分叉会话（没有 session/fork）`,
      )
    const { thread } = source.projection
    // 分叉出来的会话带着原会话的动态工具
    const tools = this.clientTools.raw(thread.id)
    const { servers, key } = await this.clientTools.mount(null, tools)
    const response = await this.ask(agent, 'session/fork', {
      sessionId: thread.id,
      cwd: thread.cwd,
      mcpServers: servers,
    }).catch((error) => {
      this.clientTools.bind(key, null)
      throw error
    })
    if (typeof response?.sessionId !== 'string') {
      this.clientTools.bind(key, null)
      throw new ProtocolError(
        -32603,
        `${agent.resolved.spec.displayName} 的 session/fork 没有回会话号`,
      )
    }
    this.clientTools.bind(key, response.sessionId)
    if (tools) this.clientTools.remember(response.sessionId, tools)
    const now = Math.floor(Date.now() / 1000)
    const live = this.fresh({
      ...thread,
      id: response.sessionId,
      name: null,
      createdAt: now,
      updatedAt: now,
      forkedFromId: thread.id,
    })
    live.projection.restore(structuredClone(source.projection.snapshot()))
    live.generation = agent.generation
    Object.assign(live.projection, {
      configOptions: structuredClone(source.projection.configOptions),
      models: structuredClone(source.projection.models),
      modes: structuredClone(source.projection.modes),
    })
    this.catalogFrom(live, response)
    live.projection.commands = source.projection.commands
    this.live.set(live.projection.thread.id, live)
    this.save(live, true)
    this.saveTurns(live)
    return live
  }

  private async attachable(): Promise<AgentHandle> {
    try {
      return await this.runtime.agent()
    } catch (error) {
      throw new ProtocolError(-32603, error instanceof Error ? error.message : String(error))
    }
  }

  // 临时线程（客户端生成标题、摘要用）：只在内存里，不建 agent 会话，线程列表里没有
  openEphemeral(peer: RpcPeer, cwd: string): LiveThread {
    const now = Math.floor(Date.now() / 1000)
    const live = this.fresh({
      id: `${EPHEMERAL_PREFIX}${randomUUID()}`,
      cwd,
      name: null,
      preview: '',
      createdAt: now,
      updatedAt: now,
      forkedFromId: null,
      ephemeral: true,
    })
    const latest = this.latestCatalog()
    if (latest) Object.assign(live.projection, structuredClone({ ...latest }))
    this.ephemeral.set(live.projection.thread.id, live)
    this.subscribe(peer, live.projection.thread.id)
    return live
  }

  // 无人订阅的临时线程立即卸载；返回卸载前它是否存在
  releaseEphemeral(id: string): boolean {
    if (!this.ephemeral.has(id)) return false
    if (!this.subscriptions.get(id)?.size) {
      this.ephemeral.delete(id)
      this.subscriptions.delete(id)
    }
    return true
  }

  /** 问过技能清单的连接，命令清单变了要告诉它 */
  watchSkills(peer: RpcPeer): void {
    this.skillPeers.set(peer.id, peer)
  }

  // ---------- 回合 ----------

  /** turn/start：回合先回给客户端，接上会话、交设置、交提示词随后在后台做；出错按失败收尾 */
  start(peer: RpcPeer, live: LiveThread, params: any): AcpTurn {
    const { projection } = live
    const clientId: string | null = params.clientUserMessageId ?? params.clientMessageId ?? null
    const submitted = clientId
      ? (live.submitted.get(clientId) ??
        projection.turns.find((turn) =>
          turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId),
        ))
      : undefined
    if (submitted) return submitted
    const input = checkedInput(params.input)
    // agent 没声明收图片的，带图片的回合直接拒绝（还没握过手的不知道，交的时候再查）
    const known = this.runtime.known
    if (known && !known.image && input.some((item) => /^(image|localImage)$/.test(item?.type)))
      throw new ProtocolError(-32602, `${this.agentName()} 不收图片`)
    if (projection.thread.ephemeral) return this.helperTurn(peer, live, params, input, clientId)
    if (params.outputSchema != null)
      throw new ProtocolError(-32602, 'ACP agent 不支持严格结构化输出（outputSchema）')
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    this.applySettings(live, params, false)
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    this.subscribe(peer, threadId)
    const turn = projection.begin(notify)
    live.starter = { turnId: turn.id, peerId: peer.id }
    projection.userMessage(echoContent(input), clientId, notify)
    if (clientId) live.submitted.set(clientId, turn)
    this.save(live, true)
    this.drive(live, turn, async (agent) => {
      const prompt = await promptContent(input, agent.caps)
      // 上一轮之后用户停掉的后台 shell 接在这句话后面（不另开回合，只交一次）。记下的是 agent 收到的整句，
      // 回放时照它找回客户端发来的样子，接上的那段不画出来
      const { blocks, text } = withStopNoticeBlocks(
        prompt,
        this.shells?.takeStopNotice(threadId) ?? null,
      )
      this.remember(threadId, text, input, clientId)
      return blocks
    })
    return turn
  }

  /**
   * 回合开了之后在后台做的：接上会话、交设置、交提示词（prompt 给出要交的内容），按 agent 的应答收尾；
   * 出错按失败收尾，被打断的按打断
   */
  private drive(
    live: LiveThread,
    turn: AcpTurn,
    prompt: (agent: AgentHandle) => Promise<unknown[]>,
  ): void {
    const { projection } = live
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    const running: Running = { turn, sent: false, stopped: false, done: Promise.resolve() }
    live.running = running
    running.done = (async () => {
      try {
        const agent = await this.attach(live)
        await this.flush(live, agent)
        const blocks = await prompt(agent)
        // 接上会话的这会儿被打断了：提示词不交
        if (running.stopped || projection.active !== turn) return
        running.sent = true
        const response = await this.ask(agent, 'session/prompt', {
          sessionId: threadId,
          prompt: blocks,
        })
        if (projection.active === turn)
          projection.finish(
            { stopReason: String(response?.stopReason ?? 'end_turn'), usage: response?.usage },
            notify,
          )
      } catch (error) {
        if (projection.active === turn)
          projection.finish(
            running.stopped
              ? { interrupted: true }
              : { error: error instanceof Error ? error.message : String(error) },
            notify,
          )
      } finally {
        if (live.running === running) live.running = null
        this.save(live, true)
        this.saveTurns(live)
      }
    })()
  }

  /**
   * 后台 shell 自己结束了（shared/src/background-shell.mts）：把结果作为一句话交给 agent，另开一轮，
   * 记成后台任务唤醒的（不画成用户的话）。正在跑一轮的等它收尾再开（ACP 回合中途不能插话）
   */
  async wake(threadId: string, tasks: ShellTask[]): Promise<void> {
    const event = await formatShellEvent(tasks)
    for (let attempt = 0; attempt < 600; attempt++) {
      if (this.closed) return
      const live = await this.load(threadId)
      const busy = live.running
      if (busy) {
        await busy.done.catch(() => {})
        continue
      }
      const started = await this.serial(threadId, async () => {
        if (live.running || live.projection.active) return false
        const notify = (method: string, value: any) => this.notify(threadId, method, value)
        const turn = live.projection.begin(notify, Date.now(), 'backgroundTask')
        live.starter = null
        this.save(live, true)
        this.drive(live, turn, async () => [
          {
            type: 'text',
            text: withStopNotice(event, this.shells?.takeStopNotice(threadId) ?? null),
          },
        ])
        return true
      })
      if (started) return
      await sleep(100)
    }
  }

  // 临时线程上的回合：没有 agent 会话。带输出结构的（标题、摘要）以空结果正常结束，客户端走自己的回退；普通回合拒绝
  private helperTurn(
    peer: RpcPeer,
    live: LiveThread,
    params: any,
    input: any[],
    clientId: string | null,
  ): AcpTurn {
    const { projection } = live
    if (params.outputSchema == null)
      throw new ProtocolError(-32602, 'ACP 入口的临时线程没有 agent 会话，不能运行普通回合')
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    this.subscribe(peer, threadId)
    const turn = projection.begin(notify)
    if (clientId) live.submitted.set(clientId, turn)
    setImmediate(() => {
      projection.userMessage(
        echoContent(input.filter((part) => part?.type === 'text')),
        clientId,
        notify,
      )
      projection.finish({ stopReason: 'end_turn' }, notify)
    })
    return turn
  }

  /**
   * 客户端换的模型、强度、计划模式先记下（pending），会话接上时交给 agent（flush）。
   * agent 报了清单的，不在清单里的值拒绝（-32602）；agent 根本没报模型或强度的，客户端带来的值不管
   *（桌面端每个回合都带着它记得的模型、强度）。lenient：新建会话允许回退时，不认识的值也不管。
   */
  applySettings(live: LiveThread, params: any, lenient: boolean): void {
    const catalog: Catalog = live.projection
    const mode = params.collaborationMode?.mode
    const model = nonEmpty(params.model) ?? nonEmpty(params.collaborationMode?.settings?.model)
    const effort =
      nonEmpty(params.effort) ?? nonEmpty(params.collaborationMode?.settings?.reasoning_effort)
    const reject = (message: string) => {
      if (!lenient) throw new ProtocolError(-32602, message)
    }
    const choices = models(catalog)
    if (model && choices.length) {
      if (choices.some((choice) => choice.value === model)) live.pending.model = model
      else reject(`${this.agentName()} 没有模型 ${model}`)
    }
    const levels = efforts(catalog)
    if (effort && levels.length) {
      if (levels.some((choice) => choice.value === effort)) live.pending.effort = effort
      else reject(`${this.agentName()} 没有强度 ${effort}`)
    }
    if (mode === 'plan' || mode === 'default') {
      if (mode === 'plan' && !planMode(catalog)) reject(`${this.agentName()} 没有计划模式`)
      else live.pending.mode = mode
    }
  }

  agentName(): string {
    return this.runtime.current()?.resolved.spec.displayName ?? this.agentId
  }

  /** 记下的设置交给 agent（会话已经接上） */
  async flush(live: LiveThread, agent: AgentHandle): Promise<void> {
    const { projection, pending } = live
    const id = projection.thread.id
    const send = (method: string, params: unknown) => this.ask(agent, method, params)
    const { model, effort, mode } = pending
    pending.model = pending.effort = pending.mode = null
    if (model && model !== currentModel(projection)) await setModel(send, id, projection, model)
    if (effort && effort !== currentEffort(projection))
      await setEffort(send, id, projection, effort)
    const plan = planMode(projection)
    const now = currentMode(projection)
    if (mode === 'plan' && plan && now !== plan) {
      live.previousMode = now
      await setMode(send, id, projection, plan)
    } else if (mode === 'default' && plan && now === plan) {
      const back =
        live.previousMode ?? modes(projection).find((choice) => choice.value !== plan)?.value
      live.previousMode = null
      if (back) await setMode(send, id, projection, back)
    }
    this.saveCatalog(live)
  }

  /** 改设置：会话接上着就立刻交给 agent，没接上的等下一回合 */
  async updateSettings(live: LiveThread, params: any): Promise<void> {
    this.applySettings(live, params, false)
    const agent = this.runtime.current()
    if (
      !live.projection.thread.ephemeral &&
      agent &&
      live.generation === agent.generation &&
      !live.running
    )
      await this.flush(live, agent)
  }

  async interrupt(id: string): Promise<void> {
    const live = this.live.get(id)
    const running = live?.running
    if (!live || !running || live.projection.active !== running.turn) return
    running.stopped = true
    // 挂着的审批撤回（回 agent “取消”，见 approvals.mts）
    this.requests.reject((threadId) => threadId === id, TURN_STOPPED)
    const agent = this.runtime.current()
    if (running.sent && agent && live.generation === agent.generation)
      agent.connection.notify('session/cancel', { sessionId: id })
    await within(running.done, INTERRUPT_WAIT_MS)
    // agent 迟迟不回 session/prompt 的，由适配器收尾
    if (live.projection.active === running.turn) {
      live.projection.finish({ interrupted: true }, (method, params) =>
        this.notify(id, method, params),
      )
      this.saveTurns(live)
    }
  }

  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.declared.delete(peer.id)
    this.skillPeers.delete(peer.id)
    this.clientTools.drop(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    for (const id of [...this.ephemeral.keys()]) this.releaseEphemeral(id)
    this.requests.dropPeer(peer.id, '客户端已断开')
  }

  // signalled：是被结束信号要求退出的，交给 AcpRuntime.close 定怎么关 agent
  async close(signalled = false): Promise<void> {
    this.closed = true
    this.requests.reject(() => true, '适配器正在关闭')
    await this.shells?.close()
    for (const live of this.live.values()) {
      if (live.projection.active) {
        live.projection.finish({ interrupted: true }, () => {})
        this.saveTurns(live)
      }
    }
    await this.runtime.close(signalled)
    await this.clientTools.close()
    await this.terminals.closeAll()
    this.files.close()
    await this.processes.close()
    this.store.close()
  }
}

/** 等 work，最多等 ms；计时器用完就清掉，不拖住进程退出 */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

const INPUT_TYPES = new Set(['text', 'skill', 'mention', 'image', 'localImage'])

/** 输入先查一遍类型：回合开出来之前就拒绝认不得的 */
function checkedInput(input: unknown): any[] {
  if (!Array.isArray(input)) throw new ProtocolError(-32602, 'input 必须是数组')
  for (const item of input)
    if (!INPUT_TYPES.has(item?.type))
      throw new ProtocolError(-32602, `不支持输入类型: ${item?.type}`)
  return input
}

function threadOf(record: SessionRecord): AcpThread {
  return {
    id: record.id,
    cwd: record.cwd,
    name: record.name,
    preview: record.preview,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    forkedFromId: record.forkedFromId,
    ephemeral: false,
  }
}
