// 一台设备上“打开着”的会话：订阅它的事件，把通知变成会话增量，受理发送、打断和答复。
// 这里维护每个会话当前的完整视图：后来的订阅者拿到的快照已经包含之前的增量。
//
// 几条规矩：
// - 打开会话用 thread/resume（载入并订阅）。对面不让订阅时退回到只取历史，会话标成只读。
// - 本机发出的消息先用临时标识显示出来（不等对面），对面给的回合标识之后一直映射到这个临时标识上，
//   界面里那个回合不会换标识、不会重排。
// - 没人看的会话，只要回合还在跑、还有请求没答、还有消息排着队，订阅就留着；都没有了才退订。
// - 断线时待答复的请求全部作废（重新订阅后对面会再发一遍），排着队的消息留着。
// - 完整模式下一台设备上有多个 harness，其中一个可以单独不可用：它上面的会话和断线时一样对待
//   （不去载入、不去发），等它恢复之后重新订阅。别的 harness 的会话不受影响。
import {
  type ClientRequests,
  EXTENSION,
  type JsonRpcId,
  type ServerNotifications,
  type Thread,
  type ThreadItem,
  type Turn,
} from '../../../protocol/src/index.mjs'
import { type Cancel, createCancel } from '../channel/cancel.mjs'
import { ChannelError, type Clock, type SessionOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { NO_REPLY, RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  ClientAskRequest,
  HarnessAbilities,
  HarnessId,
  ItemView,
  OutgoingMessage,
  QueuedMessage,
  RequestView,
  SessionAbilities,
  SessionAbility,
  SessionSettings,
  SessionView,
  TurnView,
} from '../model.mjs'
import type { ToolAnswer } from '../model-client-tools.mjs'
import { phrase } from '../phrase.mjs'
import { projectFileChange, projectItem } from '../projection/items.mjs'
import { bodyOf, localUserMessage, outgoing, toInput } from '../projection/outgoing.mjs'
import { reduceSession } from '../projection/reduce.mjs'
import {
  type PendingRequest,
  projectRequest,
  type RequestChoice,
  type RequestTerms,
} from '../projection/requests.mjs'
import { itemKey, projectThread, projectTurn } from '../projection/session.mjs'
import {
  projectMode,
  projectSettings,
  settingsDiff,
  turnOverrides,
} from '../projection/settings.mjs'
import {
  type KeptTodo,
  placeTodos,
  projectTodo,
  settleSteps,
  todoKey,
} from '../projection/todo.mjs'
import { mergeProposals, projectProposals } from '../projection/tree.mjs'
import {
  channelFailure,
  deviceFault,
  harnessDownError,
  isHarnessDown,
  isHeldElsewhere,
  lacksMethod,
} from './faults.mjs'
import type { HarnessTerms } from './harness.mjs'

export interface LiveHost {
  deviceId: string
  clock: Clock
  online(): boolean
  /** 这个会话对象属于哪个 harness */
  harnessFor(thread: Thread): HarnessId
  /** 会话目录里这个会话属于哪个 harness。目录里没有它（别处刚建的、还没取到）就是 null */
  owner(sessionId: string): HarnessId | null
  /** 这个 harness 现在能不能用。单 harness 模式下设备连着就算能用 */
  ready(harness: HarnessId): boolean
  /** 对面只有一个 harness（单 harness 模式）时是它；聚合面上是 null */
  sole(): HarnessId | null
  /** harness 给人看的名字，说明为什么做不了的时候用 */
  harnessName(harness: HarnessId): string
  /** 这个 harness 事先声明的会什么、不会什么。没有声明是 null：那就试了才知道 */
  declared(harness: HarnessId): HarnessAbilities | null
  /** 它的声明里核心自己要用的部分（认识哪些扩展、有哪几档权限预设）。没有声明是 null */
  terms(harness: HarnessId): HarnessTerms | null
  /** 这个会话是不是归档着的。归档着的只取历史来看，不订阅 */
  shelved(sessionId: string): boolean
  request<M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /**
   * 这个会话刚有了动静（发了消息、回合结束）。设备据此更新侧栏上的时间。
   * said 是刚发出去的那句话：会话还没有标题时，侧栏先拿它当标题，不等下一次对账
   */
  touched(sessionId: string, said?: string): void
  /** 刚建了一个会话。设备据此把它放进侧栏，不等对面的通知 */
  started(thread: Thread): void
  /** 一个回合结束了（turnId 是协议里的回合标识）。差异面板据此重新取；客户端工具据此收尾 */
  turnEnded?(sessionId: string, turnId: string): void
  /** 用户在这边打断了这个会话的回合（请求发出去之前）。客户端工具据此当场取消正在执行的调用 */
  interrupting?(sessionId: string): void
  /**
   * 建会话时带上的客户端工具定义（thread/start.dynamicTools）。harness 是建在哪个上，不知道是 null。
   * 返回 null 或空的就不带这个参数
   */
  dynamicTools?(harness: HarnessId | null): unknown[] | null
  /** 对面给了这个回合到现在为止的差异（整份）。工作目录不是 git 仓库时，差异面板只有它可看 */
  turnDiff?(sessionId: string, turnId: string, diff: string): void
  /** 设备服务声明了会话树（sessionTree）：载入会话时顺带取它上面等着的提案 */
  sessionTree?(): boolean
  log(line: string): void
}

export interface LiveSessions {
  open(sessionId: string, sink: HostSink): () => void
  /** 界面上有没有人开着这个会话 */
  watched(sessionId: string): boolean
  /** 设备连上并认出了对面：订阅着的会话全部重新载入 */
  resync(): void
  /** 连接断了 */
  offline(): void
  /**
   * 一个 harness 恢复可用了：它上面开着的会话重新载入并订阅（之前的订阅随它的上游连接一起丢了），
   * 为它记着的“不会做的事”清掉，它可能升级过
   */
  harnessUp(harness: HarnessId): void
  /** 一个 harness 不可用了：它上面的会话，载入中的停下，待答复的请求作废。排着队的消息留着 */
  harnessDown(harness: HarnessId): void
  /**
   * 这个会话被归档或删掉了：不再管它，排着的消息和没答的请求一并作废。
   * erased 为真是删掉了：为它记着的东西（待办进度）也不留
   */
  forget(sessionId: string, erased?: boolean): void
  /** 这个会话从归档里放回来了：正只读地开着的话，重新载入成能发消息的 */
  restored(sessionId: string): void
  /** 返回 false 表示这条通知不归会话管 */
  notification(method: string, params: unknown): boolean
  serverRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | undefined
  /**
   * 客户端工具要用户点头：在这个会话的请求卡片那一处出一张。会话没在核心里开着就载入并订阅它（回合在后台跑），
   * 载入期间先记着，载入好了一起摆上。用户答了、或者卡片被撤了（回合结束、连接断开，这时是 null）调 answer；
   * 返回的函数撤掉卡片、不再调 answer
   */
  clientAsk(
    place: { threadId: string; turnId: string; callId: string },
    request: ClientAskRequest,
    /** note：用户选了能附说明的选项（litch_machine 的拒绝）时附的那句话，没附是 null */
    answer: (answer: ToolAnswer | null, note: string | null) => void,
  ): () => void
  /**
   * 建一个会话并发出第一条消息，返回会话标识。cwd 给 null 时工作目录由对面定。
   * harness：对面是聚合面时建在哪个 harness 上；别的对面给 null，请求里不带这个参数。
   * workspaceId：归到哪个工作区；给 null 就不带，对面没有工作区这回事时也给 null
   */
  create(
    cwd: string | null,
    message: OutgoingMessage,
    settings: Partial<SessionSettings>,
    harness: HarnessId | null,
    workspaceId: string | null,
  ): Promise<string>
  /** 改模型、强度、权限预设。记在这边，下一个回合开始时一起告诉对面 */
  configure(sessionId: string, settings: Partial<SessionSettings>): void
  /** 执行计划：退出计划模式，并以 text 这句话发起一个回合。回合还在进行的时候做不了 */
  implementPlan(sessionId: string, text: string): Promise<void>
  send(sessionId: string, message: OutgoingMessage): Promise<void>
  /** 把一条排着队的消息现在就插进正在进行的回合里 */
  steer(sessionId: string, messageId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  unqueue(sessionId: string, messageId: string): void
  respond(sessionId: string, requestId: string, choice: RequestChoice): void
  /** 从 turnId 这个回合（含）分叉出一个新会话，返回新会话的标识 */
  fork(sessionId: string, turnId: string): Promise<string>
  /** 把 turnId 这个回合和它后面的都撤掉 */
  rollback(sessionId: string, turnId: string): Promise<void>
  /** 让对面开始压缩上下文。受理了就返回 */
  compact(sessionId: string): Promise<void>
  /** 用户答了一张提案（开始、不要）：开着的会话里先改成了结的样子，不等设备进程的通知 */
  settleProposal(
    sessionId: string,
    proposalId: string,
    status: 'started' | 'dismissed',
    startedId: string | null,
  ): void
}

interface Waiting extends PendingRequest {
  resolve(result: unknown): void
}

interface Live {
  id: string
  sinks: Set<HostSink>
  /** null：还没载入成功 */
  view: SessionView | null
  loading: Cancel | null
  /** 载入期间到达的通知先攒着，载入完再放 */
  held: { method: string; params: unknown }[]
  /** 协议里的回合标识 → 界面里的回合标识。只有本机发出的回合两者不同 */
  alias: Map<string, string>
  /** 已经发出 turn/start、还不知道对面给的回合标识的那个回合（界面里的标识） */
  starting: string | null
  /** 先显示出来的用户消息：界面里的回合标识 → 条目标识。对面回显这条消息时落在同一个条目上 */
  echo: Map<string, string>
  /** 按协议标识算出来的条目标识 → 界面里实际用的条目标识。只有回显的用户消息两者不同 */
  itemAlias: Map<string, string>
  /** 收到过摘要增量的推理条目，原文增量不再往里加 */
  summarized: Set<string>
  requests: Map<string, Waiting>
  queued: QueuedMessage[]
  /** 用户改了、还没告诉对面的设置 */
  pending: Partial<SessionSettings>
  /**
   * 插进回合里、对面还没回显的话：发出去时带的客户端标识 → 先显示出来的那个条目。
   * 对面真的把它交给模型时会带着这个标识回显一条用户消息，那时落在同一个条目上
   */
  steered: Map<string, { key: string; turnId: string; message: OutgoingMessage }>
  /** 我们自己发出的回退还没回来。这期间对面的“历史被改写了”通知说的就是这一次，不用重新载入 */
  reverting: boolean
}

type Notes = {
  [M in keyof ServerNotifications]?: (live: Live, params: ServerNotifications[M]) => void
}

const LOAD_TIMEOUT = 60_000

const isRunning = (view: SessionView): TurnView | undefined =>
  view.turns.findLast((turn) => turn.status === 'running')

const UNSUPPORTED = '对面不支持这个操作'

export function createLiveSessions(host: LiveHost): LiveSessions {
  const sessions = new Map<string, Live>()
  let localSeq = 0
  /**
   * 各会话的待办进度：会话标识 → 协议里的回合标识 → 那个回合的待办。
   * 协议不把它存进历史，会话放掉再打开、断线重连之后就取不回来了，所以这边记着，载入之后放回原处。
   * 只在这次运行里有效：客户端重启之后，以前的回合里就没有它了。
   */
  const todos = new Map<string, Map<string, KeptTodo>>()
  /**
   * 对面说“不认识”的那几件事，按 harness 记：一台设备上有几个 harness 时，一个不会不能连累别的。
   * 只对这一次连接有效：重新连上（或者这个 harness 掉线又回来）之后它可能升级过，从头再试
   */
  const lacking = new Map<HarnessId, Set<SessionAbility>>()

  /**
   * 这个 harness 上那几件事做不做得了：有声明照声明，没有声明先当它都会；
   * 两种情况下，对面说过“不认识”的都算不会（声明说会、实际不会的，照实际的来）
   */
  const abilities = (harness: HarnessId): SessionAbilities => {
    const lacks = lacking.get(harness)
    const declared = host.declared(harness)
    const can = (ability: SessionAbility): boolean =>
      (declared ? declared[ability] : true) && !lacks?.has(ability)
    return {
      fork: can('fork'),
      rollback: can('rollback'),
      compact: can('compact'),
      steer: can('steer'),
      steerImages: declared ? declared.steerImages : true,
      rollbackRestoresFiles: declared ? declared.rollbackRestoresFiles : false,
      finalOnStart: declared ? declared.finalOnStart : false,
      declared: declared !== null,
    }
  }

  /** 这个会话所在的 harness 收不收指向文件的 mention。没有声明的按不收算：路径写进正文，谁都读得到 */
  const mentionsIn = (live: Live): boolean =>
    live.view ? host.declared(live.view.harness)?.mentions === true : false

  /** 对面说它不会这件事：记下来，告诉这个 harness 上所有开着的会话 */
  const markLacking = (harness: HarnessId, ability: SessionAbility) => {
    const lacks = lacking.get(harness) ?? new Set<SessionAbility>()
    lacks.add(ability)
    lacking.set(harness, lacks)
    const can = abilities(harness)
    for (const other of sessions.values()) {
      if (other.view?.harness === harness) emit(other, [{ op: 'session.can', can }])
    }
  }

  /** 这个 harness 声明的权限预设。没有声明是 null，按内置的三档 */
  const presetsOf = (harness: HarnessId) => host.terms(harness)?.presets ?? null

  /**
   * 审批请求按什么条件画。“拒绝并附说明”要三样都有才给入口：这条连接声明了（握手时我们一律声明，
   * 见 link.mts）、会话所属的 harness 声明了、这次请求的决定列表里真有这一项（最后一样在 requests.mts 里看）
   */
  const requestTerms = (harness: HarnessId): RequestTerms => ({
    declineWithNote: host.terms(harness)?.extensions.includes(EXTENSION.declineWithNote) === true,
  })

  /** 这个会话属于哪个 harness：载入过就看载入的结果，没载入过看会话目录。都不知道就是 null */
  const ownerOf = (live: Live): HarnessId | null => live.view?.harness ?? host.owner(live.id)

  /**
   * 现在够不够得着这个会话：设备连着，它所属的 harness 也可用。
   * 不知道它属于谁的先当够得着，让对面自己说
   */
  const reachable = (live: Live): boolean => {
    if (!host.online()) return false
    const owner = ownerOf(live)
    return owner === null || host.ready(owner)
  }

  /** 这件事要够得着对面才做得了。够不着就说明是哪一种：设备没连上，还是它的 harness 现在不可用 */
  const mustReach = (live: Live) => {
    if (!host.online()) throw new ChannelError('offline', '设备没有连上')
    const owner = ownerOf(live)
    if (owner !== null && !host.ready(owner)) throw harnessDownError(host.harnessName(owner))
  }

  /**
   * 一批增量：先落到这边的视图上，再交给订阅的各方。
   * 增量是值：视图里放的是拷出来的一份（见 reduce.mts），交出去的这些对象之后不会再被这边改动
   */
  const emit = (live: Live, ops: SessionOp[]) => {
    if (!live.view || ops.length === 0) return
    for (const op of ops) reduceSession(live.view, op)
    for (const sink of live.sinks) sink.delta(ops)
  }

  const viewTurn = (live: Live, turnId: string): string => live.alias.get(turnId) ?? turnId

  /** 条目在界面里的标识 */
  const viewItem = (live: Live, viewId: string, itemId: string, index = 0): string => {
    const key = itemKey(viewId, itemId, index)
    return live.itemAlias.get(key) ?? key
  }

  /** 协议里的回合标识。本机刚发出、对面还没给标识的回合返回 null */
  const serverTurn = (live: Live, viewId: string): string | null => {
    for (const [server, view] of live.alias) if (view === viewId) return server
    return viewId.startsWith('local:') ? null : viewId
  }

  /** 对面第一次提到一个回合：如果本机正好有一个刚发出去的回合在等标识，就是它 */
  const bind = (live: Live, turnId: string): string => {
    const known = live.alias.get(turnId)
    if (known) return known
    if (live.starting && !live.view?.turns.some((turn) => turn.id === turnId)) {
      live.alias.set(turnId, live.starting)
      const viewId = live.starting
      live.starting = null
      return viewId
    }
    return turnId
  }

  const ensureTurn = (live: Live, viewId: string): SessionOp[] =>
    live.view?.turns.some((turn) => turn.id === viewId)
      ? []
      : [
          {
            op: 'turn.add',
            turn: {
              id: viewId,
              status: 'running',
              itemIds: [],
              startedAt: host.clock.now(),
              durationMs: null,
              error: null,
            },
          },
        ]

  const putTurn = (live: Live, turn: Turn) => {
    const viewId = bind(live, turn.id)
    const existing = live.view?.turns.find((entry) => entry.id === viewId)
    if (!existing) {
      const projected = projectTurn(turn, viewId)
      emit(live, [
        { op: 'turn.add', turn: projected.turn },
        ...projected.items.map((item): SessionOp => ({ op: 'item.add', turnId: viewId, item })),
      ])
      return
    }
    const ops: SessionOp[] = [
      {
        op: 'turn.status',
        turnId: viewId,
        status: turn.status === 'inProgress' ? 'running' : turn.status,
        durationMs: turn.durationMs ?? null,
        error: turn.error?.message ?? null,
      },
    ]
    if (turn.status !== 'inProgress') {
      // 助手消息和推理自己不带状态。回合结束了它们还显示“进行中”就不对了
      for (const itemId of existing.itemIds) {
        const item = live.view?.items[itemId]
        if (item && (item.kind === 'agentMessage' || item.kind === 'reasoning')) {
          if (item.status === 'inProgress')
            ops.push({ op: 'item.status', itemId, status: 'completed' })
        }
      }
    }
    emit(live, ops)
  }

  const putItem = (live: Live, turnId: string, item: ThreadItem, streaming: boolean) => {
    const viewId = viewTurn(live, turnId)
    const ops = ensureTurn(live, viewId)
    const position = live.view?.turns.find((turn) => turn.id === viewId)?.itemIds.length ?? 0
    // 对面回显了本机先显示出来的消息：落在同一个条目上，不多出一条。
    // 插进回合里的话按发出去时带的标识认；回合的第一条消息按“这个回合里第一条用户消息”认
    let echoed: string | undefined
    if (item.type === 'userMessage') {
      const own = itemKey(viewId, item.id, position)
      const steered = item.clientId ? live.steered.get(item.clientId) : undefined
      if (steered && item.clientId) {
        echoed = steered.key
        live.steered.delete(item.clientId)
      } else if (!live.itemAlias.has(own)) {
        // 已经对上过的条目（开始、完成各来一次）不再去认领别的
        echoed = live.echo.get(viewId)
        if (echoed) live.echo.delete(viewId)
      }
      if (echoed) live.itemAlias.set(own, echoed)
    }
    const key = echoed ?? viewItem(live, viewId, item.id, position)
    const view: ItemView = { ...projectItem(item, streaming), id: key }
    // 看着它开始的命令记下时刻：对面不增量给输出的时候，界面拿它显示“已经跑了多久”
    if (view.kind === 'command' && streaming && view.status === 'inProgress') {
      view.startedAt = host.clock.now()
    }
    ops.push({ op: 'item.add', turnId: viewId, item: view })
    emit(live, ops)
  }

  /** 往一个条目上追加文本。条目还不在（对面没发“开始”就直接出字）时先补一个空的 */
  const append = (
    live: Live,
    turnId: string,
    itemId: string,
    field: 'text' | 'output',
    text: string,
    blank: (id: string) => ItemView | null,
  ) => {
    if (!text) return
    const viewId = viewTurn(live, turnId)
    const key = viewItem(live, viewId, itemId)
    const ops = ensureTurn(live, viewId)
    if (!live.view?.items[key]) {
      const item = blank(key)
      if (!item) return
      ops.push({ op: 'item.add', turnId: viewId, item })
    }
    ops.push({ op: 'item.appendText', itemId: key, field, text })
    emit(live, ops)
  }

  const blankReasoning = (id: string): ItemView => ({
    id,
    kind: 'reasoning',
    text: '',
    status: 'inProgress',
  })

  /**
   * 一条还在跑的命令从 at 这一刻起重新计时；at 是 null 就是先不计。
   * 等批准的那一段不算在跑：审批来了把计时停掉，批完了从那一刻重新算，不然“已经跑了多久”会把等人的时间也算进去。
   */
  const clockCommand = (live: Live, request: RequestView, at: number | null): SessionOp[] => {
    const itemId = request.kind === 'approval' ? request.itemId : null
    const item = itemId ? live.view?.items[itemId] : undefined
    if (item?.kind !== 'command' || item.status !== 'inProgress') return []
    const turn = live.view?.turns.find((entry) => entry.itemIds.includes(item.id))
    return turn ? [{ op: 'item.add', turnId: turn.id, item: { ...item, startedAt: at } }] : []
  }

  const settleRequests = (live: Live, match: (request: Waiting) => boolean) => {
    const ops: SessionOp[] = []
    for (const [id, request] of live.requests) {
      if (!match(request)) continue
      live.requests.delete(id)
      request.resolve(NO_REPLY)
      ops.push({ op: 'request.remove', requestId: id })
      ops.push(...clockCommand(live, request.view, host.clock.now()))
    }
    emit(live, ops)
  }

  /**
   * 回合结束时，插进去却一直没被回显的话：
   * 回合是被打断或者出错结束的，说明它没来得及交给模型（引擎是在下一步开始前才交的）——
   * 从对话里撤掉，放回队首，照常作为下一条发出去，不让它悄悄丢了；
   * 回合正常结束的就留在对话里（有的引擎交了但不回显，再发一遍反而重复）。
   */
  const settleSteered = (live: Live, viewId: string, completed: boolean) => {
    const back: QueuedMessage[] = []
    const ops: SessionOp[] = []
    for (const [clientId, entry] of live.steered) {
      if (entry.turnId !== viewId) continue
      live.steered.delete(clientId)
      if (completed) continue
      ops.push({ op: 'item.remove', turnId: viewId, itemId: entry.key })
      back.push({ id: `q${++localSeq}`, ...entry.message })
    }
    if (back.length === 0) return
    live.queued = [...back, ...live.queued]
    emit(live, [...ops, { op: 'queue.set', queued: live.queued }])
  }

  /** 回合结束了：待办里还标着“正在做”的步骤改回“还没做” */
  const settleTodo = (live: Live, turnId: string) => {
    const viewId = viewTurn(live, turnId)
    const item = live.view?.items[todoKey(viewId)]
    if (item?.kind !== 'todo') return
    const steps = settleSteps(item.steps)
    if (steps === item.steps) return
    const kept = todos.get(live.id)?.get(turnId)
    if (kept) kept.steps = steps
    emit(live, [{ op: 'item.add', turnId: viewId, item: { ...item, steps } }])
  }

  const notes: Notes = {
    // 模型改了一次待办：整份换掉。条目的标识不变，所以它在对话里的位置也不变
    'turn/plan/updated': (live, params) => {
      const { turnId } = params
      const viewId = viewTurn(live, turnId)
      const key = todoKey(viewId)
      const kept = todos.get(live.id) ?? new Map<string, KeptTodo>()
      const todo = projectTodo(params)
      if (todo.steps.length === 0) {
        // 清空了：对话里不留一个空架子
        kept.delete(turnId)
        if (live.view?.items[key]) emit(live, [{ op: 'item.remove', turnId: viewId, itemId: key }])
        return
      }
      const ops = ensureTurn(live, viewId)
      const turn = live.view?.turns.find((entry) => entry.id === viewId)
      // 回合已经结束了才到的更新：里面“正在做”的步骤不会再动了
      const steps = turn && turn.status !== 'running' ? settleSteps(todo.steps) : todo.steps
      const at = kept.get(turnId)?.at ?? turn?.itemIds.length ?? 0
      kept.set(turnId, { at, note: todo.note, steps })
      todos.set(live.id, kept)
      ops.push({
        op: 'item.add',
        turnId: viewId,
        item: { id: key, kind: 'todo', note: todo.note, steps },
      })
      emit(live, ops)
    },
    // 上下文里现在有多少，看最近一次模型请求用掉的（累计的那个数会把每一步的上下文重复算进去）
    'thread/tokenUsage/updated': (live, { tokenUsage }) =>
      emit(live, [
        {
          op: 'session.usage',
          usage: {
            usedTokens: tokenUsage.last.totalTokens,
            windowTokens: tokenUsage.modelContextWindow,
          },
        },
      ]),
    // 设置变了：别的客户端改的，或者引擎自己改的（模型退出了计划模式）。这一版只跟模式：
    // 模型、强度、权限这几项各有各的认法，回合之间换了的话下次载入会话时会对上
    'thread/settings/updated': (live, { threadSettings }) => {
      const mode = projectMode(threadSettings?.collaborationMode?.mode)
      if (!mode || !live.view) return
      // 对面说了算：这边想改还没发出去的那一下不留着
      delete live.pending.mode
      if (live.view.settings.mode === mode) return
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, mode } }])
    },
    'turn/started': (live, { turn }) => putTurn(live, turn),
    'turn/completed': (live, { turn }) => {
      putTurn(live, turn)
      settleTodo(live, turn.id)
      settleSteered(live, viewTurn(live, turn.id), turn.status === 'completed')
      // 回合结束时还没答的请求已经没有意义了
      settleRequests(live, (request) => request.turnId === turn.id)
      host.touched(live.id)
      host.turnEnded?.(live.id, turn.id)
      pump(live)
      release(live)
    },
    // 这个回合到现在为止改了什么。对话里不显示它（文件改动的条目里已经有了），留给差异面板
    'turn/diff/updated': (live, { turnId, diff }) => host.turnDiff?.(live.id, turnId, diff),
    'item/started': (live, { item, turnId }) => putItem(live, turnId, item, true),
    'item/completed': (live, { item, turnId }) => putItem(live, turnId, item, false),
    'item/agentMessage/delta': (live, { turnId, itemId, delta }) =>
      append(live, turnId, itemId, 'text', delta, (id) => ({
        id,
        kind: 'agentMessage',
        text: '',
        phase: 'unknown',
        status: 'inProgress',
      })),
    'item/reasoning/summaryTextDelta': (live, { turnId, itemId, delta }) => {
      live.summarized.add(viewItem(live, viewTurn(live, turnId), itemId))
      append(live, turnId, itemId, 'text', delta, blankReasoning)
    },
    'item/reasoning/summaryPartAdded': (live, { turnId, itemId, summaryIndex }) => {
      // 摘要的各段之间空一行，和定稿之后拼出来的一样
      if (summaryIndex > 0) append(live, turnId, itemId, 'text', '\n\n', blankReasoning)
    },
    'item/reasoning/textDelta': (live, { turnId, itemId, delta }) => {
      if (live.summarized.has(viewItem(live, viewTurn(live, turnId), itemId))) return
      append(live, turnId, itemId, 'text', delta, blankReasoning)
    },
    'item/commandExecution/outputDelta': (live, { turnId, itemId, delta }) =>
      append(live, turnId, itemId, 'output', delta, () => null),
    'item/plan/delta': (live, { turnId, itemId, delta }) =>
      append(live, turnId, itemId, 'text', delta, (id) => ({ id, kind: 'plan', text: '' })),
    'item/fileChange/patchUpdated': (live, { turnId, itemId, changes }) => {
      const viewId = viewTurn(live, turnId)
      const current = live.view?.items[viewItem(live, viewId, itemId)]
      if (current?.kind !== 'fileChange') return
      const item: ItemView = { ...current, changes: changes.map(projectFileChange) }
      emit(live, [{ op: 'item.add', turnId: viewId, item }])
    },
    error: (live, { error, willRetry, turnId }) => {
      // 不再重试的错误，随后的“回合结束”里带着同样的原因；这里只留个记录
      host.log(
        `会话 ${live.id} 的回合 ${turnId} 报错（${willRetry ? '会重试' : '不再重试'}）：${error.message}`,
      )
    },
    'serverRequest/resolved': (live, { requestId }) =>
      settleRequests(live, (request) => request.view.id === String(requestId)),
    // 会话的历史被改写了（别的客户端回退了它）：不知道撤掉了哪些，整个重新载入
    'thread/reverted': (live) => {
      if (!live.reverting) load(live)
    },
    // 会话树：这个会话上的提案变了（新提、开始、不要、撤回、过期），带着现在全部等着的和刚变的那几条
    'litch/sessionProposal/changed': (live, { proposals, changed }) => {
      if (!live.view) return
      const merged = mergeProposals(live.view.proposals, proposals, changed ?? [], host.clock.now())
      emit(live, [{ op: 'session.proposals', proposals: merged }])
    },
  }

  // ---------- 载入与释放 ----------

  const failure = (error: unknown): ChannelError => channelFailure(error, host.harnessName)

  const fetchView = async (live: Live, cancel: Cancel): Promise<SessionView> => {
    const scope = (thread: Thread) => ({
      deviceId: host.deviceId,
      harness: host.harnessFor(thread),
    })
    const options = { timeoutMs: LOAD_TIMEOUT, signal: cancel.signal }
    if (host.shelved(live.id)) {
      // 归档着的会话：只取历史来看，不恢复、不订阅。要接着聊得先把它放回来
      const { thread } = await host.request(
        'thread/read',
        { threadId: live.id, includeTurns: true },
        options,
      )
      return {
        ...projectThread(thread, scope(thread)),
        live: false,
        note: phrase('session.archived'),
      }
    }
    try {
      const resumed = await host.request('thread/resume', { threadId: live.id }, options)
      const view = projectThread(resumed.thread, scope(resumed.thread))
      return {
        ...view,
        settings: projectSettings(resumed, presetsOf(view.harness)),
        proposals: await proposalsOf(live.id, options),
      }
    } catch (error) {
      // 只有对面明确说“订阅不了”才退回去只取历史；断线、超时照常报错。
      // 它所属的 harness 不可用也不是“订阅不了”：只读地取同样取不到，等它恢复再载入
      if (!(error instanceof RpcError) || isHarnessDown(error)) throw error
      host.log(`订阅会话 ${live.id} 失败，改为只读载入：${error.message}`)
      const { thread } = await host.request(
        'thread/read',
        { threadId: live.id, includeTurns: true },
        options,
      )
      return {
        ...projectThread(thread, scope(thread)),
        live: false,
        // 被别处的 codex 用着：说清楚是怎么回事、该怎么办，不甩一句原话
        note: isHeldElsewhere(error)
          ? phrase('session.heldElsewhere')
          : phrase('session.readOnly', { message: error.message }),
      }
    }
  }

  /** 会话上的提案，连了结的一起。设备没有会话树、问不到都当没有：提案不是看会话的必需品 */
  const proposalsOf = async (
    threadId: string,
    options: RpcRequestOptions,
  ): Promise<SessionView['proposals']> => {
    if (!host.sessionTree?.()) return []
    try {
      const { proposals } = await host.request(
        'litch/sessionProposal/list',
        { threadId, includeSettled: true },
        options,
      )
      return projectProposals(proposals, host.clock.now())
    } catch (error) {
      if (error instanceof RpcError && !isHarnessDown(error)) {
        host.log(`取会话 ${threadId} 的提案失败：${error.message}`)
        return []
      }
      throw error
    }
  }

  const load = (live: Live) => {
    live.loading?.abort()
    const cancel = createCancel()
    live.loading = cancel
    live.held = []
    fetchView(live, cancel).then(
      (view) => {
        if (cancel.signal.aborted) return
        live.loading = null
        live.alias.clear()
        live.echo.clear()
        live.itemAlias.clear()
        live.summarized.clear()
        live.starting = null
        live.view = {
          ...view,
          queued: live.queued,
          settings: { ...view.settings, ...live.pending },
          // 重新载入时对面不一定再报一遍，先留着上一次的
          usage: view.usage ?? live.view?.usage ?? null,
          can: abilities(view.harness),
        }
        const kept = todos.get(live.id)
        if (kept) placeTodos(live.view, kept)
        // 客户端工具的卡片是这边自己的，对面给的会话里没有：还挂着的放回去
        for (const waiting of live.requests.values()) {
          if (waiting.view.kind !== 'clientAsk') continue
          if (!live.view.requests.some((request) => request.id === waiting.view.id)) {
            live.view.requests.push(waiting.view)
          }
        }
        for (const sink of live.sinks) sink.snapshot(live.view)
        const held = live.held
        live.held = []
        for (const entry of held) deliver(live, entry.method, entry.params, true)
        pump(live)
        release(live)
      },
      (error: unknown) => {
        if (cancel.signal.aborted) return
        live.loading = null
        // 载入到一半它所属的 harness 不可用了：订阅留着，等它恢复再载入
        if (isHarnessDown(error)) return
        const reason = failure(error)
        // 载入到一半连接断了：订阅留着，等设备重新连上再载入
        if (reason.code === 'offline') return
        for (const sink of [...live.sinks]) sink.error(reason)
        live.sinks.clear()
        sessions.delete(live.id)
      },
    )
  }

  /** 没人看、也没有在跑的事了，就退订并放掉 */
  const release = (live: Live) => {
    if (live.sinks.size > 0 || live.loading) return
    if (live.view && (isRunning(live.view) || live.requests.size > 0 || live.queued.length > 0))
      return
    sessions.delete(live.id)
    // 够不着的时候不用退：订阅已经随连接（或者它的 harness 的上游连接）一起没了
    if (live.view?.live && reachable(live)) {
      host.request('thread/unsubscribe', { threadId: live.id }).catch((error: unknown) => {
        host.log(`退订会话 ${live.id} 失败：${String(error)}`)
      })
    }
  }

  // ---------- 发送 ----------

  /** clientId：这条消息在客户端这边的标识，要让对面认出这是哪一条时才给（执行计划） */
  const startTurn = async (
    live: Live,
    message: OutgoingMessage,
    clientId: string | null = null,
  ): Promise<void> => {
    const viewId = `local:${++localSeq}`
    const userKey = `${viewId}:user`
    const mentions = mentionsIn(live)
    live.starting = viewId
    live.echo.set(viewId, userKey)
    emit(live, [
      {
        op: 'turn.add',
        turn: {
          id: viewId,
          status: 'running',
          itemIds: [userKey],
          startedAt: host.clock.now(),
          durationMs: null,
          error: null,
        },
      },
      { op: 'item.add', turnId: viewId, item: localUserMessage(userKey, message, mentions) },
    ])
    // 改过的设置跟着这个回合一起告诉对面，之后的回合对面会沿用
    const sent = { ...live.pending }
    // 它声明了自己的权限预设的话，只发预设的标识
    const declared = live.view ? presetsOf(live.view.harness) !== null : false
    const overrides = turnOverrides(sent, declared, live.view?.settings)
    try {
      const { turn } = await host.request(
        'turn/start',
        {
          threadId: live.id,
          input: toInput(message, mentions),
          ...overrides,
          ...(clientId ? { clientUserMessageId: clientId } : {}),
        },
        { timeoutMs: LOAD_TIMEOUT },
      )
      // 对面收下了。请求途中用户又改过的那几项留着，下个回合再发。
      // 模式要是这一回没带上（还不知道模型），也留着
      for (const key of Object.keys(sent) as (keyof SessionSettings)[]) {
        if (key === 'mode' && !overrides.collaborationMode) continue
        if (live.pending[key] === sent[key]) delete live.pending[key]
      }
      // 通知可能比应答先到，那时已经对上了；没对上就在这里对
      if (!live.view?.turns.some((entry) => entry.id === viewId)) return
      bind(live, turn.id)
      // 回合在应答到达之前就结束了的极端情况：以应答里的状态为准
      if (turn.status !== 'inProgress') putTurn(live, turn)
      host.touched(live.id, bodyOf(message, mentions))
    } catch (error) {
      if (live.starting === viewId) live.starting = null
      live.echo.delete(viewId)
      emit(live, [{ op: 'turn.remove', turnId: viewId }])
      throw failure(error)
    }
  }

  const setNote = (live: Live, note: SessionView['note']) => {
    if (live.view) emit(live, [{ op: 'session.state', live: live.view.live, note }])
  }

  /** 空下来了就把排着队的第一条发出去 */
  const pump = (live: Live) => {
    if (!live.view?.live || !reachable(live) || isRunning(live.view)) return
    const next = live.queued[0]
    if (!next) return
    live.queued = live.queued.slice(1)
    emit(live, [{ op: 'queue.set', queued: live.queued }])
    startTurn(live, next).then(
      () => {
        if (live.view?.note) setNote(live, null)
      },
      (error: unknown) => {
        // 没发出去：放回队首，停下来等用户处理，不自己反复重试
        live.queued = [next, ...live.queued]
        emit(live, [{ op: 'queue.set', queued: live.queued }])
        setNote(live, phrase('session.queueFailed', { message: failure(error).message }))
      },
    )
  }

  const deliver = (live: Live, method: string, params: unknown, replay = false) => {
    const handler = (notes as Record<string, ((live: Live, params: never) => void) | undefined>)[
      method
    ]
    if (!handler) return
    if (live.loading) {
      live.held.push({ method, params })
      return
    }
    if (!live.view) return
    if (replay && method.endsWith('elta')) {
      // 载入期间攒下的文本增量：条目已经在快照里的不再加，免得同一段文字出现两遍。
      // 就算因此少了几个字，条目定稿时对面会给出完整内容。
      const { turnId, itemId } = params as { turnId: string; itemId: string }
      if (live.view.items[viewItem(live, viewTurn(live, turnId), itemId)]) return
    }
    handler(live, params as never)
  }

  const blank = (id: string): Live => ({
    id,
    sinks: new Set(),
    view: null,
    loading: null,
    held: [],
    alias: new Map(),
    starting: null,
    echo: new Map(),
    itemAlias: new Map(),
    summarized: new Set(),
    requests: new Map(),
    queued: [],
    pending: {},
    steered: new Map(),
    reverting: false,
  })

  /**
   * 做一件不是每个引擎都会的事。它声明了不会的不去发；没有声明（或者声明说会）的照常发，
   * 对面说不认识这个方法：记住这个会话所属的 harness 不会，告诉它上面所有开着的会话，报“不支持”；
   * 别的错照常报，下次还能再试。别的 harness 的会话不受影响：它们各自试了才知道。
   */
  const attempt = async <T,>(
    live: Live & { view: SessionView },
    ability: SessionAbility,
    run: () => Promise<T>,
  ): Promise<T> => {
    const { harness } = live.view
    // 声明了不会的、试过不行的：不去发
    if (!abilities(harness)[ability]) throw new ChannelError('unsupported', UNSUPPORTED)
    try {
      return await run()
    } catch (error) {
      if (!lacksMethod(error)) throw failure(error)
      // 聚合面替它说“不支持”的时候写着是哪个 harness：照它说的记
      markLacking(deviceFault(error)?.harness ?? harness, ability)
      throw new ChannelError('unsupported', UNSUPPORTED)
    }
  }

  /** 这些事都要够得着对面、没有回合在进行。why 是回合在进行时对人说的那句 */
  const idle = (sessionId: string, why: string): Live & { view: SessionView } => {
    const live = need(sessionId)
    mustReach(live)
    if (isRunning(live.view)) throw new ChannelError('rejected', why)
    return live
  }

  const need = (sessionId: string): Live & { view: SessionView } => {
    const live = sessions.get(sessionId)
    if (!live?.view) throw new ChannelError('notFound', `会话没有打开：${sessionId}`)
    return live as Live & { view: SessionView }
  }

  return {
    open(sessionId, sink) {
      let live = sessions.get(sessionId)
      if (!live) {
        live = blank(sessionId)
        sessions.set(sessionId, live)
      }
      const entry = live
      entry.sinks.add(sink)
      if (entry.view) sink.snapshot(entry.view)
      // 设备还没连上就先等着，连上时会统一载入；它所属的 harness 现在不可用也一样，恢复时再载入
      else if (!entry.loading && reachable(entry)) load(entry)
      return () => {
        entry.sinks.delete(sink)
        if (entry.sinks.size === 0 && !entry.view) {
          entry.loading?.abort()
          entry.loading = null
          sessions.delete(entry.id)
          return
        }
        release(entry)
      }
    },

    watched: (sessionId) => (sessions.get(sessionId)?.sinks.size ?? 0) > 0,

    resync() {
      lacking.clear()
      for (const live of [...sessions.values()]) {
        if (live.sinks.size === 0 && live.queued.length === 0) sessions.delete(live.id)
        // 所属的 harness 这时不可用的先不载入，留着上次的内容，等它恢复（harnessUp）
        else if (reachable(live)) load(live)
      }
    },

    offline() {
      for (const live of sessions.values()) {
        live.loading?.abort()
        live.loading = null
        live.starting = null
        settleRequests(live, () => true)
      }
    },

    harnessUp(harness) {
      lacking.delete(harness)
      for (const live of [...sessions.values()]) {
        if (ownerOf(live) !== harness) continue
        if (live.sinks.size === 0 && live.queued.length === 0) sessions.delete(live.id)
        else load(live)
      }
    },

    harnessDown(harness) {
      for (const live of sessions.values()) {
        if (ownerOf(live) !== harness) continue
        live.loading?.abort()
        live.loading = null
        live.starting = null
        settleRequests(live, () => true)
      }
    },

    forget(sessionId, erased = false) {
      if (erased) todos.delete(sessionId)
      const live = sessions.get(sessionId)
      if (!live) return
      live.loading?.abort()
      live.loading = null
      live.queued = []
      settleRequests(live, () => true)
      sessions.delete(sessionId)
    },

    restored(sessionId) {
      const live = sessions.get(sessionId)
      if (!live) return
      if (live.sinks.size === 0) sessions.delete(sessionId)
      else if (reachable(live)) load(live)
    },

    settleProposal(sessionId, proposalId, status, startedId) {
      const live = sessions.get(sessionId)
      if (!live?.view?.proposals.some((proposal) => proposal.id === proposalId)) return
      const settledAt = host.clock.now()
      emit(live, [
        {
          op: 'session.proposals',
          proposals: live.view.proposals.map((proposal) =>
            proposal.id === proposalId ? { ...proposal, status, settledAt, startedId } : proposal,
          ),
        },
      ])
    },

    notification(method, params) {
      if (!(method in notes)) return false
      const threadId = (params as { threadId?: unknown } | null)?.threadId
      const live = typeof threadId === 'string' ? sessions.get(threadId) : undefined
      if (live) deliver(live, method, params)
      return true
    },

    serverRequest(method, params, id) {
      const threadId = (params as { threadId?: unknown } | null)?.threadId
      const live = typeof threadId === 'string' ? sessions.get(threadId) : undefined
      // 没有打开的会话来了请求：不能替用户答。回“方法不存在”，对面按没人答复处理
      if (!live?.view) return undefined
      const pending = projectRequest(method, params, String(id), requestTerms(live.view.harness))
      if (!pending) return undefined
      const viewId = pending.turnId ? viewTurn(live, pending.turnId) : null
      const key = viewId && pending.itemId ? viewItem(live, viewId, pending.itemId) : null
      const view = { ...pending.view, itemId: key && live.view.items[key] ? key : null }
      return new Promise<unknown>((resolve) => {
        live.requests.set(view.id, { ...pending, view, resolve })
        emit(live, [{ op: 'request.add', request: view }, ...clockCommand(live, view, null)])
      })
    },

    clientAsk(place, request, answer) {
      let live = sessions.get(place.threadId)
      if (!live) {
        // 会话没在核心里开着（没人看、回合在后台跑）：载入并订阅，卡片才有地方摆
        live = blank(place.threadId)
        sessions.set(live.id, live)
        if (reachable(live)) load(live)
      }
      const entry = live
      const viewId = viewTurn(entry, place.turnId)
      const key = viewItem(entry, viewId, place.callId)
      const view: ClientAskRequest = {
        ...request,
        itemId: entry.view?.items[key] ? key : null,
      }
      let open = true
      const waiting: Waiting = {
        threadId: place.threadId,
        turnId: place.turnId,
        itemId: place.callId,
        view,
        answer(choice) {
          const option = view.options.find((one) => one.id === choice.optionId)
          if (!option) return null
          const pick: ToolAnswer =
            option.role === 'accept'
              ? 'once'
              : option.role === 'acceptSession'
                ? 'session'
                : option.role === 'acceptAlways'
                  ? 'always'
                  : 'decline'
          return { pick, note: option.note ? choice.note?.trim() || null : null }
        },
        resolve(result) {
          if (!open) return
          open = false
          if (result === NO_REPLY) answer(null, null)
          else {
            const { pick, note } = result as { pick: ToolAnswer; note: string | null }
            answer(pick, note)
          }
        },
      }
      entry.requests.set(view.id, waiting)
      emit(entry, [{ op: 'request.add', request: view }])
      return () => {
        if (!open) return
        open = false
        if (entry.requests.get(view.id) !== waiting) return
        entry.requests.delete(view.id)
        emit(entry, [{ op: 'request.remove', requestId: view.id }])
        release(entry)
      }
    },

    async create(cwd, message, settings, harness, workspaceId) {
      if (!host.online()) throw new ChannelError('offline', '设备没有连上')
      let started: Awaited<ReturnType<typeof host.request<'thread/start'>>>
      // 还没有会话对象：它算在谁头上，聚合面上就是指定的那个，单个入口上只有那一个
      const target = harness ?? host.sole()
      const presets = target === null ? null : presetsOf(target)
      // 这台桌面能执行的客户端工具（都默认带上，用的时候再查开关）。工具只能在建会话时定
      const tools = host.dynamicTools?.(target) ?? null
      try {
        // 建会话时能带的先带上（模型、权限）；带不了的（强度、协作模式）跟着第一个回合发
        const {
          effort: _later,
          collaborationMode: _withTurn,
          ...atStart
        } = turnOverrides(settings, presets !== null)
        started = await host.request(
          'thread/start',
          {
            cwd,
            ...atStart,
            // 聚合面上这是“针对某个 harness”的请求，要指明建在哪个上；别的对面不认识这个参数，不带
            ...(harness === null ? {} : { harness }),
            // 归到哪个工作区。这是协议里原有的参数；对面没有工作区这回事时调用方给的是 null
            ...(workspaceId === null ? {} : { projectId: workspaceId }),
            ...(tools && tools.length > 0 ? { dynamicTools: tools as never } : {}),
          },
          { timeoutMs: LOAD_TIMEOUT },
        )
      } catch (error) {
        throw failure(error)
      }
      const { thread } = started
      const live = blank(thread.id)
      const owner = host.harnessFor(thread)
      const actual = projectSettings(started, presetsOf(owner))
      live.pending = settingsDiff(settings, actual)
      live.view = {
        ...projectThread(thread, { deviceId: host.deviceId, harness: owner }),
        settings: { ...actual, ...live.pending },
        can: abilities(owner),
      }
      sessions.set(live.id, live)
      host.started(thread)
      try {
        await startTurn(live, message)
      } catch (error) {
        // 第一条消息没发出去：界面会把文字还给用户重新来，这个空会话不留着
        sessions.delete(live.id)
        host.request('thread/unsubscribe', { threadId: live.id }).catch(() => {})
        throw error
      }
      return live.id
    },

    configure(sessionId, settings) {
      const live = need(sessionId)
      for (const key of ['model', 'effort', 'permission'] as const) {
        const value = settings[key]
        if (value) live.pending[key] = value
      }
      if (settings.mode) live.pending.mode = settings.mode
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, ...live.pending } }])
    },

    async implementPlan(sessionId, text) {
      const live = need(sessionId)
      if (!live.view.live) throw new ChannelError('rejected', '这个会话是只读的')
      mustReach(live)
      if (isRunning(live.view) || live.queued.length > 0) {
        throw new ChannelError('rejected', '回合还在进行，现在执行不了计划')
      }
      // 退出计划模式和“执行”是同一个回合里的事：模式跟着这个回合发过去。
      // 标识以 plan: 开头是和适配器的约定：Pi 引擎认出来之后走它自己的“实施计划”，不把这句话当成新的要求
      live.pending.mode = 'default'
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, ...live.pending } }])
      await startTurn(live, outgoing(text), `plan:${host.clock.now()}-${++localSeq}`)
    },

    async send(sessionId, message) {
      const live = need(sessionId)
      if (!live.view.live) throw new ChannelError('rejected', '这个会话是只读的')
      mustReach(live)
      if (isRunning(live.view) || live.queued.length > 0) {
        live.queued = [...live.queued, { id: `q${++localSeq}`, ...message }]
        emit(live, [{ op: 'queue.set', queued: live.queued }])
        pump(live)
        return
      }
      await startTurn(live, message)
      if (live.view.note) setNote(live, null)
    },

    async steer(sessionId, messageId) {
      const live = need(sessionId)
      const message = live.queued.find((entry) => entry.id === messageId)
      if (!message) throw new ChannelError('rejected', '这条消息已经不在队列里了')
      const running = isRunning(live.view)
      const turnId = running ? serverTurn(live, running.id) : null
      if (!running || !turnId) throw new ChannelError('rejected', '现在没有可以插话的回合')
      const { harness } = live.view
      const can = abilities(harness)
      // 声明了不会的、试过不行的：不去发，消息照常排着等这个回合结束
      if (!can.steer) throw new ChannelError('unsupported', UNSUPPORTED)
      if (!can.steerImages && message.images.length > 0) {
        throw new ChannelError(
          'rejected',
          '带图片的消息不能中途插进去',
          phrase('fault.steerImages'),
        )
      }
      const clientId = `litch-${host.deviceId}-${++localSeq}`
      const key = `${running.id}:steer:${localSeq}`
      // 先从队列里拿出来、显示进回合里，不等对面
      live.queued = live.queued.filter((entry) => entry !== message)
      const { id: _queueId, ...said } = message
      const mentions = mentionsIn(live)
      live.steered.set(clientId, { key, turnId: running.id, message: said })
      emit(live, [
        { op: 'queue.set', queued: live.queued },
        { op: 'item.add', turnId: running.id, item: localUserMessage(key, said, mentions) },
      ])
      try {
        await host.request('turn/steer', {
          threadId: sessionId,
          expectedTurnId: turnId,
          clientUserMessageId: clientId,
          input: toInput(said, mentions),
        })
      } catch (error) {
        // 没插成：放回队首，照常等这个回合结束再发
        live.steered.delete(clientId)
        live.queued = [message, ...live.queued]
        emit(live, [
          { op: 'item.remove', turnId: running.id, itemId: key },
          { op: 'queue.set', queued: live.queued },
        ])
        pump(live)
        if (!lacksMethod(error)) throw failure(error)
        // 对面不会引导：记下来，这个 harness 上的入口都停掉
        markLacking(deviceFault(error)?.harness ?? harness, 'steer')
        throw new ChannelError('unsupported', UNSUPPORTED)
      }
    },

    async interrupt(sessionId) {
      const live = need(sessionId)
      const running = isRunning(live.view)
      const turnId = running ? serverTurn(live, running.id) : null
      if (!turnId) throw new ChannelError('rejected', '没有可以打断的回合')
      host.interrupting?.(sessionId)
      try {
        await host.request('turn/interrupt', { threadId: sessionId, turnId })
      } catch (error) {
        throw failure(error)
      }
    },

    unqueue(sessionId, messageId) {
      const live = need(sessionId)
      const next = live.queued.filter((message) => message.id !== messageId)
      if (next.length === live.queued.length) return
      live.queued = next
      emit(live, [{ op: 'queue.set', queued: next }])
      release(live)
    },

    respond(sessionId, requestId, choice) {
      const live = need(sessionId)
      const request = live.requests.get(requestId)
      if (!request) throw new ChannelError('rejected', '这个请求已经不在了')
      if (choice.note?.trim()) {
        // 说明只能跟着声明了能带说明的选项走，别的不替用户悄悄丢掉
        const { view } = request
        const option =
          view.kind === 'approval' || view.kind === 'clientAsk'
            ? view.options.find((entry) => entry.id === choice.optionId)
            : undefined
        if (!option?.note) throw new ChannelError('rejected', '这个选项不能附说明')
      }
      const result = request.answer(choice)
      if (result === null) throw new ChannelError('rejected', '这个请求没有这样的选项')
      live.requests.delete(requestId)
      request.resolve(result)
      emit(live, [
        { op: 'request.remove', requestId },
        ...clockCommand(live, request.view, host.clock.now()),
      ])
    },

    async fork(sessionId, turnId) {
      const live = idle(sessionId, '回合还在进行，结束之后才能分叉')
      const last = live.view.turns.some((turn) => turn.id === turnId)
        ? serverTurn(live, turnId)
        : null
      if (!last) throw new ChannelError('rejected', '这个回合已经不在了')
      const { thread } = await attempt(live, 'fork', () =>
        host.request(
          'thread/fork',
          // 新会话的内容打开时再取，这里不要
          { threadId: sessionId, lastTurnId: last, excludeTurns: true },
          { timeoutMs: LOAD_TIMEOUT },
        ),
      )
      host.started(thread)
      return thread.id
    },

    async rollback(sessionId, turnId) {
      const live = idle(sessionId, '回合还在进行，结束之后才能回退')
      if (!live.view.live) throw new ChannelError('rejected', '这个会话是只读的')
      const before = live.view.turns.some((turn) => turn.id === turnId)
        ? serverTurn(live, turnId)
        : null
      if (!before) throw new ChannelError('rejected', '这个回合已经不在了')
      live.reverting = true
      try {
        // 按回合的标识回退，不按“倒数几个”：两边数出来的个数万一不一样，撤错了找不回来
        await attempt(live, 'rollback', () =>
          host.request(
            'thread/revert',
            { threadId: sessionId, beforeTurnId: before },
            { timeoutMs: LOAD_TIMEOUT },
          ),
        )
      } finally {
        live.reverting = false
      }
      // 对面撤掉了，这边跟着拿掉。请求途中会话重新载入过的话回合的标识换成了协议里的，两种都认；
      // 已经不在了（重新载入时就没有它了）就什么都不用做
      const turns = live.view?.turns ?? []
      const at = turns.findIndex((turn) => turn.id === turnId || turn.id === before)
      const gone = at < 0 ? [] : turns.slice(at).map((turn) => turn.id)
      for (const viewId of gone) {
        const server = serverTurn(live, viewId)
        if (server) {
          todos.get(live.id)?.delete(server)
          live.alias.delete(server)
        }
        live.echo.delete(viewId)
        for (const key of [...live.itemAlias.keys()]) {
          if (key.startsWith(`${viewId}:`)) live.itemAlias.delete(key)
        }
      }
      emit(
        live,
        gone.map((viewId): SessionOp => ({ op: 'turn.remove', turnId: viewId })),
      )
      host.touched(live.id)
    },

    async compact(sessionId) {
      const live = idle(sessionId, '回合还在进行，结束之后才能压缩')
      if (!live.view.live) throw new ChannelError('rejected', '这个会话是只读的')
      await attempt(live, 'compact', () =>
        host.request('thread/compact/start', { threadId: sessionId }, { timeoutMs: LOAD_TIMEOUT }),
      )
      host.touched(live.id)
    },
  }
}
