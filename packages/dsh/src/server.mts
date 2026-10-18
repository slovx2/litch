import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  isClientToolNamespace,
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
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
import { approve } from './approvals.mjs'
import { ClientToolBridge, type DshClientTool, dshClientTools } from './client-tools.mjs'
import { summary } from './envelope.mjs'
import {
  type DshThread,
  type DshTurn,
  knownPreset,
  type Preset,
  Projection,
  type ProjectionHooks,
  type SubagentInfo,
} from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { ask, TURN_STOPPED } from './questions.mjs'
import { RemoteError, type Waterfall, type WaterfallOutcome, type WebRemote } from './remote.mjs'
import { DshRuntime, EXIT_TIMING } from './runtime.mjs'
import { DshSkills, isSkillsSession } from './skills.mjs'
import { DshStore } from './store.mjs'
import { echoContent, promptContent } from './turn.mjs'
import { compatibilityHint } from './versions.mjs'

// 调试用：CHA_DSH_TRACE 指向文件时逐行记录与客户端往来的协议消息，默认关闭。
const tracePath = process.env.CHA_DSH_TRACE
const trace = (direction: 'in' | 'out', message: unknown) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ direction, message })}\n`)
}

const EPHEMERAL_PREFIX = 'ephemeral-'
// dsh 的 session/follow 对它没有的会话报的错误码（对着 dsh 0.2.0-rc.2 实测，用例在 foreign-thread.test.mts）
const SESSION_NOT_FOUND = 'session/not-found'
// 拿普通会话地址去跟随子代理的会话，dsh 报这个（要用派它的会话的地址）；子代理地址里的方式不对报后一个
const AGENT_BUSY = 'session/agent-busy'
const SUBAGENT_UNAUTHORIZED = 'subagent/unauthorized'
// 子代理地址里的方式：要和子代理实际的方式对上，dsh 才让跟随（对着 0.2.0-rc.2 实测）
const SUBAGENT_MODES = ['continuable', 'one-shot', 'unknown'] as const

type SessionAddress =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: string }

export interface LiveThread {
  projection: Projection
  cancel: () => void
  // 桌面为线程选定的权限预设；与 dsh 当前预设不同时在下一回合前切换。
  preset: Preset | null
  // 本进程内已受理的提交标识；用户消息落盘前的重复提交据此返回同一回合。
  submitted: Map<string, DshTurn>
  // 最近一个回合的提示词交给 dsh 了没有：交到了、没交成都算完。打断和插话要等它（见 interrupt）。
  delivered: Promise<void>
  // 哪条连接发起的哪个回合（客户端工具按它挑执行方）。dsh 自己开的回合（子代理结束后告诉模型）不在这里
  starter: { peer: string; turn: DshTurn } | null
}

export class DshServer {
  readonly store: DshStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly live = new Map<string, LiveThread>()
  // 临时线程（客户端生成标题、摘要时用）：只在内存里，没有 dsh 会话，无人订阅即卸载。
  readonly ephemeral = new Map<string, LiveThread>()
  readonly runtime: DshRuntime
  readonly skills: DshSkills
  private readonly loading = new Map<string, Promise<LiveThread>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  // dsh 现有的会话，最近一次问来的（见 sessions）：会话标识 → 摘要。
  private known = new Map<string, DshThread>()
  // 另问过、确实说过话的会话（见 blank）：说过话的不会变回没说过，不用每次列清单都再问。
  private readonly spoken = new Set<string>()
  // 另问过、确实没说过话的会话：会话要说话得先由适配器打开（open 时去掉），所以这个 dsh 进程里不用再问；
  // dsh 退出了就作废（它收场时没写完的缓存，新起的那个读到的可能是旧的）。
  private readonly silent = new Set<string>()
  // 发给客户端并等回答的请求：发给会话的全部订阅连接，先答的生效（见 ServerRequests）。
  private readonly requests = new ServerRequests((threadId, method, params) =>
    this.notify(threadId, method, params),
  )
  // 每条连接握手时声明能执行的客户端工具命名空间（clientTools 扩展）
  readonly toolNamespaces = new Map<string, ReadonlySet<string>>()
  // 跑在 dsh 里的客户端工具插件和适配器之间的连接（client-tools.mts）
  readonly bridge: ClientToolBridge
  // 会话的客户端工具，摊平成交给 dsh 模型的样子（clientTools）
  private readonly clientToolCache = new Map<string, DshClientTool[]>()

  constructor(home: string) {
    this.store = new DshStore(home)
    // 项目存储要问的会话情况。dsh 的会话不在适配器的库里，由 knownThread 去找；
    // 归档是适配器这边记的界面状态，最近活动时间不算归档了的和临时的。
    this.projects = new ProjectStore(this.store.db, {
      find: (id) => this.knownThread(id),
      recency: (ids) => {
        const times = ids.flatMap((id) => {
          const thread = this.knownThread(id)
          const archived = this.store.getMeta('thread', id)?.archived === true
          return thread && !thread.ephemeral && !archived ? [thread.updatedAt] : []
        })
        return times.length ? Math.max(...times) : null
      },
    })
    this.queue = new QueueStore(this.store.db)
    this.bridge = new ClientToolBridge({
      tools: (id) => this.clientTools(id),
      call: (id, callId, name, args, signal) => this.clientToolCall(id, callId, name, args, signal),
    })
    this.runtime = new DshRuntime(
      home,
      {
        waterfall: (frame, signal) => this.waterfall(frame, signal),
        emit: () => {},
        closed: (error) => this.runtimeClosed(error),
      },
      EXIT_TIMING,
      () => this.bridge.patch(),
    )
    this.skills = new DshSkills(home, this.runtime)
  }

  remote(): Promise<WebRemote> {
    return this.runtime.remote()
  }

  /** dsh 的模型目录（session/modelCatalog 的原样）：各家的模型和强度档，还有没选过模型的会话用的默认 */
  async catalog(): Promise<any> {
    return (await this.remote()).rpc('session/modelCatalog', {}, (value) =>
      Array.isArray(value?.groups),
    )
  }

  // 这个会话下一次请求会用的模型和强度。dsh 那边选过的、上一次请求用过的，投影里有，以它为准。
  // 两样都没有的是还没说过话的新会话：dsh 到发请求时用它当时的默认，就是模型目录里的 default
  //（不是固定的：任何会话里选一次模型，它都跟着变成那一个），强度没写的用那个模型自己的默认强度。
  // 目录问不到时有什么报什么，不为这个让建会话、恢复会话失败。
  async selection(
    thread: Pick<DshThread, 'ephemeral' | 'model' | 'effort'>,
  ): Promise<{ model: string | null; effort: string | null }> {
    if (thread.ephemeral || (thread.model && thread.effort))
      return { model: thread.model, effort: thread.effort }
    const catalog = await this.catalog().catch(() => null)
    const preferred = thread.model ? null : (catalog?.default ?? null)
    const model = thread.model ?? (preferred ? `${preferred.provider}/${preferred.model}` : null)
    const listed = (catalog?.groups ?? [])
      .flatMap((group: any) =>
        (group.models ?? []).map((entry: any) => ({ ...entry, id: `${group.id}/${entry.id}` })),
      )
      .find((entry: any) => entry.id === model)
    const effort = thread.effort ?? preferred?.reasoningEffort ?? listed?.reasoning?.defaultEffort
    return { model, effort: effort ?? null }
  }

  /** 问 dsh 现有哪些会话（session/list 的原样，含还没说过话的），顺手记下来给项目存储用 */
  async sessions(): Promise<any[]> {
    const { items } = await (await this.remote()).rpc('session/list', { _request: {} }, (value) =>
      Array.isArray(value?.items),
    )
    // 只用来问技能的会话不是线程，按会话号认：线程列表和项目都不该看到它
    const sessions = (items as any[]).filter((item) => !isSkillsSession(item.sessionId))
    this.known = new Map(sessions.map((item) => [item.sessionId, summary(item)]))
    return sessions
  }

  /** 进线程列表的那些会话：说过话的。没说过话的不列，和上游一样（它不列没有预览的会话） */
  async listedSessions(): Promise<any[]> {
    const remote = await this.remote()
    const sessions = await this.sessions()
    const blank = await Promise.all(sessions.map((item) => this.blank(remote, item)))
    return sessions.filter((_, index) => !blank[index])
  }

  // dsh 的清单项自带“空白”（还没起过回合），但没打开的会话这一项出自它的投影缓存（projections.kind 是 cached），
  // 缓存会落后于会话记录：dsh 在会话建好、回合结束、会话关掉和隔一阵时写缓存，都不等写完，回合刚结束它就收场时
  // 一次都可能没落盘，缓存还是建好时那份“空白”；缓存里干脆没有这个会话时（会话刚建好就收场了、缓存作废了）
  // 它一律报成不空白。所以只信 dsh 内存里的投影（打开着的会话，kind 是 sequenced）和缓存里的“说过话”
  //（说过话的不会变回没说过），别的另问一次它的投影，那是照会话记录现算的，不打开会话。
  // 问不成的照 dsh 报的算，宁可多列一个空的，不把说过话的藏掉。
  private async blank(remote: WebRemote, item: any): Promise<boolean> {
    const id = item.sessionId
    if (this.spoken.has(id)) return false
    const listed = item.projections?.values?.sessionListMetadata
    if (listed && (item.projections.kind === 'sequenced' || listed.blank === false))
      return item.blank === true
    if (this.silent.has(id)) return true
    const asked = await remote
      .rpc('session/projections', { request: { sessionId: id } })
      .catch(() => null)
    const blank = asked?.values?.sessionListMetadata?.blank
    if (blank === false) this.spoken.add(id)
    if (blank === true) this.silent.add(id)
    return blank === true
  }

  // 打开着的会话以内存里的投影为准，没打开的看最近一次问 dsh 记下的。
  private knownThread(id: string): DshThread | null {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    return loaded?.projection.thread ?? this.known.get(id) ?? null
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
      this.requests.answer(peer, message)
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32603
      const text = error instanceof Error ? error.message : String(error)
      // 打样阶段靠这行日志找出桌面端用到而尚未实现的方法。会话不在这里不记：那是正常的应答
      //（官方桌面端找置顶会话在哪台机器上时，拿别处的会话号向每个入口都问，隔一会儿又问一遍）。
      if (!(error instanceof ThreadNotFound))
        console.error(`[dsh] ${message.method} 失败（${code}）: ${text}`)
      peer.send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    } finally {
      // 这次请求可能让这条连接订阅了某个会话：应答发出之后，把还在等人回答的请求补送给它，
      // 先后与原生“恢复会话后重放挂起的请求”一致。
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
    // 会话的新建、状态、改名、归档这些和上游一样发给所有连接，没订阅这个会话的客户端靠它们跟着变；
    // 临时线程的除外（客户端起标题用的，不进列表，别的连接拿到只会多出一个列表里没有的会话）
    const everyone =
      threadId === null ||
      (BROADCAST_THREAD_NOTIFICATIONS.has(method) && !threadId.startsWith(EPHEMERAL_PREFIX))
    for (const peer of this.peers.values())
      if (everyone || (threadId !== null && this.subscriptions.get(threadId)?.has(peer.id)))
        peer.send({ method, params: threadId ? { threadId, ...params } : params })
  }

  /** 订阅着这个线程、还连着的连接，按订阅的先后 */
  subscribers(threadId: string): RpcPeer[] {
    return [...(this.subscriptions.get(threadId) ?? [])].flatMap((id) => this.peers.get(id) ?? [])
  }

  // 向订阅了该线程的全部客户端发起反向请求（审批），先答的生效；signal 中止时撤回。
  call(threadId: string, method: string, params: any, signal?: AbortSignal): Promise<any> {
    return this.requests.send(
      this.subscribers(threadId),
      threadId,
      method,
      (id) => ({
        threadId,
        turnId: this.live.get(threadId)?.projection.active?.id ?? '',
        itemId: id,
        ...params,
      }),
      { signal, replayable: true },
    )
  }

  // 打开会话的跟随流：先用快照回放历史，之后的落盘事件与实时增量转成协议通知。
  load(id: string): Promise<LiveThread> {
    const loaded = this.live.get(id) ?? this.ephemeral.get(id)
    if (loaded) return Promise.resolve(loaded)
    // 临时线程卸载后不复存在，不必去问 dsh。
    if (id.startsWith(EPHEMERAL_PREFIX)) return Promise.reject(new ThreadNotFound(id))
    const loading =
      this.loading.get(id) ??
      this.open(id).finally(() => {
        this.loading.delete(id)
      })
    this.loading.set(id, loading)
    return loading
  }

  // 打开一个会话。dsh 的子代理会话不能拿普通的会话地址跟随（它报 session/agent-busy），要用派它的会话的地址，
  // 地址里的方式还得和子代理实际的方式对上（不对报 subagent/unauthorized）。不知道它是子代理的（清单是旧的）
  // 先按普通会话试，被拒了再问一遍清单。
  private async open(id: string): Promise<LiveThread> {
    this.silent.delete(id)
    const remote = await this.remote()
    try {
      let parent = this.knownThread(id)?.parentThreadId ?? null
      if (!parent) {
        try {
          return await this.follow(remote, id, { kind: 'session', sessionId: id })
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === AGENT_BUSY)) throw error
          await this.sessions()
          parent = this.known.get(id)?.parentThreadId ?? null
          if (!parent) throw error
        }
      }
      // 知道是哪种的先按那种，不知道的先按 continuable（dsh 默认派的就是这种）
      const known = this.subagentInfo(id)?.mode
      let refused: unknown = null
      for (const mode of new Set([known ?? 'continuable', ...SUBAGENT_MODES])) {
        try {
          return await this.follow(remote, id, {
            kind: 'subagent',
            parentSessionId: parent,
            childSessionId: id,
            mode,
          })
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === SUBAGENT_UNAUTHORIZED)) throw error
          refused = error
        }
      }
      throw refused
    } catch (error: any) {
      // dsh 没有这个会话：多半是别的 harness 的会话号（桌面端找会话在哪台机器上时每个入口都问），照上游答“这里没有”。
      // 别的失败（连接断了这类）带着原话照旧报
      if (error instanceof RemoteError && error.code === SESSION_NOT_FOUND)
        throw new ThreadNotFound(id)
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(-32602, error?.message ?? '未知 dsh 会话')
    }
  }

  // 跟随一个会话：先用快照回放历史，之后的落盘事件与实时增量转成协议通知。失败时原样交出 dsh 的错误（见 open）
  private follow(remote: WebRemote, id: string, address: SessionAddress): Promise<LiveThread> {
    const notify = (method: string, params: any) => this.notify(id, method, params)
    return new Promise<LiveThread>((resolve, reject) => {
      let live: LiveThread | null = null
      // 首帧必须是带记录数组的快照；不是或迟迟不来都按接口不兼容报错，不让调用方一直挂着。
      const mismatch = (detail: string) => {
        clearTimeout(timer)
        cancel()
        reject(new ProtocolError(-32603, `${detail}。${compatibilityHint(remote.version)}`))
      }
      const timer = setTimeout(() => mismatch('dsh 的 session/follow 没有返回会话快照'), 15000)
      const cancel = remote.open(
        'session/follow',
        { request: { address, assistantStream: true } },
        (value) => {
          if (value?.type === 'snapshot' && Array.isArray(value.records)) {
            clearTimeout(timer)
            const opened: LiveThread = {
              projection: replay(
                id,
                value,
                (owner, requestId) => this.recall(owner, requestId),
                this.store.getMeta('display', id),
                {
                  clientTool: (name) =>
                    this.clientTools(id).find((tool) => tool.name === name) ?? null,
                  subagent: (child, info) => this.rememberSubagent(child, info),
                },
              ),
              cancel: () => cancel(),
              preset: null,
              submitted: new Map(),
              delivered: Promise.resolve(),
              starter: null,
            }
            live = opened
            const ready = () => {
              // 取图片的这会儿流断了的不算打开了
              if (live !== opened) return
              this.display(id, opened.projection)
              this.live.set(id, opened)
              resolve(opened)
            }
            // 有没记录的图片时先取回来再交出去，交出去的历史就是全的
            if (opened.projection.unfetched.length)
              void this.restoreImages(remote, opened.projection).then(ready)
            else ready()
          } else if (!live) mismatch('dsh 的 session/follow 首帧不是适配器认识的会话快照')
          else if (value.type === 'event') {
            live.projection.apply(value.event, notify)
            if (value.event.type === 'user/message' || value.event.type === 'session/title')
              this.display(id, live.projection)
          } else if (value.type === 'assistant-stream') live.projection.stream(value.frame, notify)
        },
        (error) => {
          clearTimeout(timer)
          if (this.live.get(id) === live) this.live.delete(id)
          live?.projection.fail('dsh 会话流已中断', notify)
          live = null
          reject(error ?? new Error('dsh 会话流已中断'))
        },
      )
    })
  }

  /** 一个子代理的情况（方式、标签）：见过派它的会话或者打开过它才知道，记在适配器库里 */
  subagentInfo(threadId: string): SubagentInfo | null {
    return this.live.get(threadId)?.projection.subagent ?? this.store.getMeta('subagent', threadId)
  }

  // 投影里见到了一个子代理的情况：记下来，列清单（canAcceptDirectInput、标签）和打开它（地址里的方式）时用。
  // 派它的会话里的 catalog 和它自己的 descriptor 各报一次，后报的补上前面没有的
  private rememberSubagent(threadId: string, info: SubagentInfo): void {
    const saved: SubagentInfo | null = this.store.getMeta('subagent', threadId)
    const merged: SubagentInfo = {
      mode: info.mode ?? saved?.mode ?? null,
      label: info.label ?? saved?.label ?? null,
    }
    if (JSON.stringify(saved) !== JSON.stringify(merged))
      this.store.setMeta('subagent', threadId, merged)
  }

  // 客户端发来的输入原样记一份，按会话和提交标识（就是 dsh 那条用户消息上的 source.rpcId）。
  // dsh 的记录里技能只是一句“/名字”，图片是它存下的附件（可能缩小、转码过）；回给客户端的用户消息要是发来的样子，
  // 靠的就是这一份：实时回显和重读历史读的都是它。提示词没交成的那一份留在库里没人读。
  remember(threadId: string, requestId: string, input: any[]): void {
    this.store.setMeta('input', `${threadId}:${requestId}`, { content: echoContent(input) })
  }

  private recall(threadId: string, requestId: string): any[] | null {
    return this.store.getMeta('input', `${threadId}:${requestId}`)?.content ?? null
  }

  // 会话没打开时，预览和名字只有 dsh 的清单给的那一份：预览是它照交给它的那一句截的（点了技能的是“/名字”打头），
  // 名字只有几个字，分不出是不是它的兜底标题（不当名字，见 Projection.title），而且可能是旧的（模型的标题刚落下
  // dsh 就退出了，清单里还是兜底标题）。所以打开着的时候把这几样记下来，变了就改，列清单时照这一份报（envelope）。
  private display(id: string, projection: Projection): void {
    const shown = {
      preview: projection.thread.preview,
      name: projection.named,
      fallback: projection.fallback,
    }
    const saved = this.store.getMeta('display', id)
    if (JSON.stringify(saved) !== JSON.stringify(shown)) this.store.setMeta('display', id, shown)
  }

  // 没有记录的用户消息（Projection.unfetched）里的图片从 dsh 取回来：它按附件号给得出存下的那一份，
  // 以带地址的图片补在那句话后面。取不到的那一张就没有，不为它让会话打不开。
  private async restoreImages(remote: WebRemote, projection: Projection): Promise<void> {
    const wanted = projection.unfetched.splice(0)
    const fetched = await Promise.all(
      wanted.map(({ attachmentId }) =>
        remote
          .rpc('session/attachment', { request: { sessionId: projection.thread.id, attachmentId } })
          .catch(() => null),
      ),
    )
    wanted.forEach(({ content }, index) => {
      const { attachment, data } = fetched[index] ?? {}
      if (typeof data === 'string' && typeof attachment?.mediaType === 'string')
        content.push({ type: 'image', url: `data:${attachment.mediaType};base64,${data}` })
    })
  }

  // dsh 没有不落盘的会话，这里只建内存里的线程：不调用 dsh，线程列表和 dsh 的会话存储里都不会出现。
  openEphemeral(
    peer: RpcPeer,
    values: { cwd: string; model: string | null; effort: string | null; preset: Preset | null },
  ): LiveThread {
    const now = Math.floor(Date.now() / 1000)
    const thread: DshThread = {
      id: `${EPHEMERAL_PREFIX}${randomUUID()}`,
      cwd: values.cwd,
      name: null,
      preview: '',
      createdAt: now,
      updatedAt: now,
      model: values.model,
      effort: values.effort,
      preset: values.preset ?? 'read-only',
      parentThreadId: null,
      forkedFromId: null,
      ephemeral: true,
    }
    const live: LiveThread = {
      projection: new Projection(thread),
      cancel: () => {},
      preset: values.preset,
      submitted: new Map(),
      delivered: Promise.resolve(),
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

  start(peer: RpcPeer, live: LiveThread, params: any): DshTurn {
    const { projection } = live
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    const submitted = clientId
      ? (live.submitted.get(clientId) ??
        projection.turns.find((turn) =>
          turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId),
        ))
      : undefined
    if (submitted) return submitted
    if (projection.thread.ephemeral) return this.helperTurn(peer, live, params, clientId)
    if (params.outputSchema != null)
      throw new ProtocolError(-32602, 'dsh 入口暂不支持严格结构化输出')
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    this.assertDirectInput(live)
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    this.subscribe(peer, threadId)
    const turn = projection.expect(notify)
    if (clientId) live.submitted.set(clientId, turn)
    live.starter = { peer: peer.id, turn }
    const deliver = async () => {
      try {
        const content = await promptContent(params.input ?? [])
        const remote = await this.remote()
        await this.applySettings(remote, live, params)
        // 提交标识落在 dsh 用户消息的 source.rpcId 上，回放时还原为条目的 clientId。
        const requestId = clientId ?? randomUUID()
        this.remember(threadId, requestId, params.input ?? [])
        await this.prompt(remote, live, requestId, 'queue', content)
      } catch (error) {
        if (projection.active === turn)
          projection.fail(error instanceof Error ? error.message : String(error), notify)
      }
    }
    // 回合先回给客户端，提示词随后才交给 dsh。
    live.delivered = new Promise((resolve) => setImmediate(() => void deliver().then(resolve)))
    return turn
  }

  // 临时线程上的回合：没有 dsh 会话也就没有模型可用。带输出结构的回合（标题、摘要等）以空结果
  // 正常结束，客户端按"没有结果"走自己的回退；普通回合如实拒绝。标题改由 dsh 自己生成后推送。
  private helperTurn(
    peer: RpcPeer,
    live: LiveThread,
    params: any,
    clientId: string | null,
  ): DshTurn {
    const { projection } = live
    if (params.outputSchema == null)
      throw new ProtocolError(-32602, 'dsh 没有不落盘的会话，临时线程不能运行普通回合')
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    this.subscribe(peer, threadId)
    const turn = projection.expect(notify)
    if (clientId) live.submitted.set(clientId, turn)
    setImmediate(() => {
      const content = (Array.isArray(params.input) ? params.input : []).filter(
        (part: any) => part?.type === 'text',
      )
      projection.apply(
        {
          type: 'user/message',
          seq: -1,
          time: Date.now(),
          data: {
            id: clientId ?? randomUUID(),
            source: { kind: 'user', rpcId: clientId },
            content,
          },
        },
        notify,
      )
      projection.apply(
        { type: 'turn/end', seq: -1, time: Date.now(), data: { reason: { kind: 'completed' } } },
        notify,
      )
    })
    return turn
  }

  // 子代理只有后台可继续的能接着发消息（见 envelope 的 canAcceptDirectInput）
  assertDirectInput(live: LiveThread): void {
    const { thread } = live.projection
    if (thread.parentThreadId && this.subagentInfo(thread.id)?.mode !== 'continuable')
      throw new ProtocolError(
        -32602,
        'dsh 的这个子代理不能接着对话：只有后台跑、可继续的子代理收得到后续消息',
      )
  }

  /**
   * 把一句话交给 dsh。普通会话走 session/prompt；子代理的会话 dsh 不让直接发（session/agent-busy），
   * 要经派它的会话的地址走 subagents/prompt。mode：queue 是排到下一个回合，steer 是并进正在跑的回合。
   */
  async prompt(
    remote: WebRemote,
    live: LiveThread,
    requestId: string,
    mode: 'queue' | 'steer',
    content: any[],
  ): Promise<void> {
    const { thread } = live.projection
    if (thread.parentThreadId)
      await remote.rpc('subagents/prompt', {
        request: {
          requestId,
          parentSessionId: thread.parentThreadId,
          childSessionId: thread.id,
          mode: 'continuable',
          delivery: mode,
          content,
        },
      })
    else
      await remote.rpc('session/prompt', {
        request: { requestId, sessionId: thread.id, mode, content },
      })
  }

  async applySettings(remote: WebRemote, live: LiveThread, params: any): Promise<void> {
    const { thread } = live.projection
    // 子代理的权限和模型是派它时定的，dsh 不让从它自己的会话里改：客户端带来的设置不管
    if (thread.parentThreadId) return
    const preset = presetFromParams(params) ?? live.preset
    if (preset) live.preset = preset
    if (thread.ephemeral) {
      // 没有 dsh 会话可设置，只记下客户端选的值用于回报。
      if (preset) thread.preset = preset
      if (typeof params.model === 'string' && params.model) thread.model = params.model
      if (typeof params.effort === 'string' && params.effort) thread.effort = params.effort
      return
    }
    if (preset && preset !== thread.preset)
      await remote.rpc('commands/execute', {
        agentId: thread.id,
        line: `/permission ${preset}`,
        submittedAttachments: [],
      })
    const model = typeof params.model === 'string' && params.model ? params.model : null
    const effort = typeof params.effort === 'string' && params.effort ? params.effort : null
    if ((!model || model === thread.model) && (!effort || effort === thread.effort)) return
    // 只改强度、会话又还没选过模型的：模型是它本来会用的那个默认。
    const selected = model ?? thread.model ?? (await this.selection(thread)).model
    const slash = selected?.indexOf('/') ?? -1
    if (!selected || slash < 1) throw new ProtocolError(-32602, '模型格式必须为 provider/model')
    await remote.rpc('session/selectModel', {
      request: {
        sessionId: thread.id,
        provider: selected.slice(0, slash),
        model: selected.slice(slash + 1),
        ...((effort ?? thread.effort) ? { reasoningEffort: effort ?? thread.effort } : {}),
      },
    })
    // 选择结果随后也会经落盘事件到达，这里先更新以便立即回报新设置。
    thread.model = selected
    thread.effort = effort ?? thread.effort
  }

  async interrupt(id: string): Promise<void> {
    const live = this.live.get(id)
    const turn = live?.projection.active
    if (!live || !turn) return
    if (live.projection.thread.parentThreadId && this.subagentInfo(id)?.mode !== 'continuable')
      throw new ProtocolError(
        -32602,
        'dsh 不让单独打断这种子代理（跑完就结束的那种），请打断派它的会话',
      )
    this.requests.reject((threadId) => threadId === id, TURN_STOPPED)
    // 回合是适配器先建的，提示词随后才交给 dsh（见 start）。dsh 的取消只停正在跑的回合：
    // 提示词还没到就发过去，它没有回合可停，回合随后照常跑完。所以等提示词交到了再取消，
    // 那时 dsh 那边回合已经起来。没交成的回合已经按失败收尾，不用再取消。
    await live.delivered
    if (live.projection.active !== turn) return
    const remote = await this.remote()
    const { thread } = live.projection
    // 子代理的会话 dsh 不让直接取消，要经派它的会话的地址（只认可继续的那种）
    if (thread.parentThreadId)
      await remote.rpc('subagents/interruptByParent', {
        childSessionId: id,
        parentSessionId: thread.parentThreadId,
        mode: 'continuable',
      })
    else await remote.rpc('session/cancel', { request: { sessionId: id } })
    for (let waited = 0; waited < 10000 && live.projection.active === turn; waited += 50)
      await sleep(50)
    // dsh 迟迟没有回报结束时由适配器收尾。
    if (live.projection.active === turn)
      live.projection.apply(
        { type: 'turn/end', seq: -1, time: Date.now(), data: { reason: { kind: 'interrupted' } } },
        (method, params) => this.notify(id, method, params),
      )
  }

  /** 会话建时带的动态工具（thread/start.dynamicTools，记在适配器库里），摊平成交给 dsh 模型的样子 */
  clientTools(threadId: string): DshClientTool[] {
    let tools = this.clientToolCache.get(threadId)
    if (!tools) {
      // 记下的是建会话时核对过的，这里不会出错；万一库里的坏了，当作没有，不让会话打不开
      try {
        tools = dshClientTools(this.store.getMeta('dynamicTools', threadId))
      } catch {
        tools = []
      }
      this.clientToolCache.set(threadId, tools)
    }
    return tools
  }

  /** 建会话时记下它的动态工具（重启、恢复之后还在），交给 dsh 里的插件装上 */
  async setClientTools(threadId: string, raw: unknown[]): Promise<void> {
    this.store.setMeta('dynamicTools', threadId, raw)
    this.clientToolCache.delete(threadId)
    await this.bridge.install(threadId)
  }

  /**
   * dsh 的模型调了会话的一个客户端工具（插件交回来的）：向客户端发标准的 item/tool/call，答复原样交回。
   * litch_ 开头的命名空间照 clientTools 扩展的规矩挑执行方（shared/src/client-tool-executor.mts），挑不出来当场回
   * noExecutor；别的命名空间照 Pi 入口的做法交给发起回合的连接，它不在了交给最早订阅的那条。
   * 一次调用只发给一条连接，不补送给后来订阅的；执行方断开、回合被打断都按失败结束。
   */
  async clientToolCall(
    threadId: string,
    callId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const tool = this.clientTools(threadId).find((one) => one.name === name)
    if (!tool) return clientToolFailure('invalid', `这个会话没有 ${name} 这个工具。`)
    const { namespace } = tool
    const live = this.live.get(threadId)
    const starting = live?.starter
    // 发起这个回合的连接：回合还是它发起的那个、它还连着才算
    const starter =
      starting && live?.projection.active === starting.turn
        ? (this.peers.get(starting.peer) ?? null)
        : null
    const subscribers = this.subscribers(threadId)
    const litch = isClientToolNamespace(namespace)
    const target = litch
      ? pickClientToolExecutor(
          namespace as string,
          starter,
          subscribers,
          (peer) => this.toolNamespaces.get(peer.id) ?? new Set(),
        )
      : (starter ?? subscribers[0] ?? null)
    if (!target)
      return litch
        ? noClientToolExecutor(namespace as string)
        : clientToolFailure('noExecutor', '这个会话现在没有连着的客户端执行这个工具。')
    const params = {
      threadId,
      turnId: live?.projection.active?.id ?? '',
      callId,
      namespace,
      tool: tool.tool,
      arguments: args ?? {},
    }
    try {
      const result = await this.requests.send([target], threadId, 'item/tool/call', () => params, {
        signal,
        replayable: false,
      })
      if (typeof result?.success !== 'boolean' || !Array.isArray(result.contentItems))
        return clientToolFailure('failed', '客户端的答复不符合协议，这次调用按失败处理。')
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return clientToolFailure(
        'failed',
        `这次调用没有完成（${reason}）。执行它的 Litch 断开了或者回合被打断了，不要反复重试。`,
      )
    }
  }

  private async waterfall(frame: Waterfall, signal: AbortSignal): Promise<WaterfallOutcome> {
    const live = this.live.get(frame.agentId)
    if (live && frame.event === 'approval/request')
      return approve(this, live, frame.request ?? {}, signal)
    if (live && frame.event === 'user-questions/request')
      return ask(this, live, frame.request ?? {}, signal)
    // 别的交回 dsh，由它按“没有应答方”处理。
    return { kind: 'next' }
  }

  private runtimeClosed(error: Error): void {
    this.silent.clear()
    for (const [id, live] of this.live)
      live.projection.fail(`dsh 进程已退出：${error.message}`, (method, params) =>
        this.notify(id, method, params),
      )
    this.live.clear()
  }

  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.toolNamespaces.delete(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    this.skills.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    for (const id of [...this.ephemeral.keys()]) this.releaseEphemeral(id)
    // 订阅者断开只摘掉它自己：别的连接还拿着的请求继续等，一条都不剩的才结束。
    this.requests.dropPeer(peer.id, '客户端已断开')
  }

  // signalled：是被结束信号要求退出的，交给 DshRuntime.close 定怎么关 dsh。
  async close(signalled = false): Promise<void> {
    this.requests.reject(() => true, '适配器正在关闭')
    this.skills.close()
    await this.runtime.close(signalled)
    this.bridge.close()
    this.files.close()
    await this.processes.close()
    this.store.close()
  }
}

export function presetFromParams(params: any): Preset | null {
  const profiles: Record<string, Preset> = {
    ':read-only': 'read-only',
    ':workspace': 'workspace-write',
    ':danger-full-access': 'danger-full-access',
    readOnly: 'read-only',
    workspaceWrite: 'workspace-write',
    dangerFullAccess: 'danger-full-access',
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
    'danger-full-access': 'danger-full-access',
  }
  for (const value of [
    params.permissions,
    params.activePermissionProfile?.id,
    params.sandboxPolicy?.type,
    params.sandbox,
  ])
    if (typeof value === 'string' && profiles[value]) return profiles[value]
  return null
}

// recall：按会话和提交标识找记下的输入（DshServer.recall）。shown：上回记下的预览和名字（DshServer.display）。
function replay(
  id: string,
  snapshot: any,
  recall: (threadId: string, requestId: string) => any[] | null,
  shown: { preview: string; name: string | null; fallback: string | null } | null,
  hooks: Omit<ProjectionHooks, 'recorded'>,
): Projection {
  const values = snapshot.projections?.values ?? {}
  const header = snapshot.header ?? {}
  const subagent = header.origin === 'subagent'
  const createdAt = Math.floor(Number(snapshot.header?.createdAt ?? Date.now()) / 1000)
  const thread: DshThread = {
    id,
    cwd: snapshot.header?.cwd ?? '',
    name: null,
    preview: '',
    createdAt,
    updatedAt: createdAt,
    model: null,
    effort: null,
    preset: knownPreset(values.permissions?.currentValue) ?? 'workspace-write',
    // 会话头里子代理和分叉出来的会话都有 parentSession，origin 是 subagent 的才是子代理
    parentThreadId: subagent ? (header.parentSession ?? null) : null,
    forkedFromId: subagent ? null : (header.parentSession ?? null),
    ephemeral: false,
  }
  // dsh 自己分叉出来的会话带着上一级的记录，那些用户消息的提交标识也是上一级的：自己名下没有的到上一级名下找。
  const parent = thread.forkedFromId
  const projection = new Projection(thread, {
    ...hooks,
    recorded: (requestId) => recall(id, requestId) ?? (parent ? recall(parent, requestId) : null),
  })
  projection.contextWindow = values.contextPressure?.contextWindow ?? null
  projection.titled = typeof values.title === 'string'
  // dsh 的快照只带末尾一段记录（它默认给最近 50 条消息）。会话长了，头一句话和早先的标题事件不在里面，
  // 回放不出预览和名字：先按知道的摆上（上回记下的，没记过就用 dsh 的投影给的），回放里有的再照回放来。
  if (snapshot.hasMore) {
    thread.preview = shown?.preview || String(values.turnOutline?.[0]?.prompt ?? '')
    projection.named = shown ? shown.name : typeof values.title === 'string' ? values.title : null
    projection.fallback = shown?.fallback ?? null
    thread.name = projection.named
  }
  let time = createdAt * 1000
  for (const record of snapshot.records ?? [])
    if (record.type === 'event') {
      projection.apply(record.event, () => {})
      time = record.event.time
    }
  // 模型以快照自带的投影为准：它是按整个会话算的，快照里的记录不一定从头开始。
  projection.selection(values.modelSelection)
  // 回放结束仍未收尾的回合属于上一个已退出的 dsh 进程。
  if (projection.active)
    projection.apply(
      { type: 'turn/end', seq: -1, time, data: { reason: { kind: 'interrupted' } } },
      () => {},
    )
  return projection
}
