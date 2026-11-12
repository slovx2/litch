import { inputDelivery } from '../../../protocol/src/input-delivery.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import { questionSource } from '../../../protocol/src/pending-asks.mjs'
import { restorePendingView, withdrawnInputOps } from './pending-projection.mjs'
// 一台设备上“打开着”的会话：订阅它的事件，把通知变成会话增量，受理发送、打断和答复。
// 这里维护每个会话已读取的历史和实时状态：后来的订阅者拿到的快照已经包含之前的增量。
//
// 几条规矩：
// - 打开会话用 thread/resume（载入并订阅）。对面不让订阅时退回到只取历史，会话标成只读。
// - 本机发出的消息先用临时标识显示出来（不等对面），对面给的回合标识之后一直映射到这个临时标识上，
//   界面里那个回合不会换标识、不会重排。
// - 没人看的会话，只要回合还在跑、还有请求没答、还有消息排着队，订阅就留着；都没有了才退订。
// - 断线时待答复的请求全部作废（重新订阅后对面会再发一遍），排着队的消息留着。
// - 完整模式下一台设备上有多个 harness，其中一个可以单独不可用：它上面的会话和断线时一样对待
//   （不去载入、不去发），等它恢复之后重新订阅。别的 harness 的会话不受影响。

import { prepareSpeed, type SpeedStore } from '../../../protocol/src/codex-speeds.mjs'
import {
  type ClientRequests,
  EXTENSION,
  type JsonRpcId,
  type ServerNotifications,
  type Thread,
  type ThreadItem,
  type Turn,
  type UserInput,
} from '../../../protocol/src/index.mjs'
import type { WorktreeFrom } from '../../../protocol/src/worktrees.mjs'
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
import type { GoalChange, SessionGoalView } from '../model-goal.mjs'
import type { AgentThreadView } from '../model-tree.mjs'
import { phrase } from '../phrase.mjs'
import { looksLikeGoalTurn, projectGoal } from '../projection/goal.mjs'
import { projectFileChange, projectItem, settledItem } from '../projection/items.mjs'
import { bodyOf, localUserMessage, outgoing, toInput } from '../projection/outgoing.mjs'
import { reduceSession } from '../projection/reduce.mjs'
import {
  type PendingRequest,
  projectRequest,
  type RequestChoice,
  type RequestTerms,
} from '../projection/requests.mjs'
import { itemKey, originOf, projectThread, projectTurn } from '../projection/session.mjs'
import {
  projectMode,
  projectSettings,
  settingsDiff,
  turnOverrides,
} from '../projection/settings.mjs'
import { withSideChatNote } from '../projection/side-chat.mjs'
import { spanOp } from '../projection/span.mjs'
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
  goalsOff,
  harnessDownError,
  isHarnessDown,
  isHeldElsewhere,
  isManagerResetWaiting,
  isSessionRecovering,
  lacksMethod,
} from './faults.mjs'
import type { HarnessTerms } from './harness.mjs'
import {
  HISTORY_PAGE_SIZE,
  historyPage,
  INITIAL_HISTORY,
  initialHistory,
  lacksPaging,
} from './history.mjs'
import { resumeAfterRecovery } from './resume-retry.mjs'
import { staleView, trimView, type ViewStore } from './view-store.mjs'

export interface LiveHost {
  beforeInput?(sessionId: string): Promise<void> | undefined
  recoverySupported?(): boolean
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
  declared(harness: HarnessId, sessionId?: string): HarnessAbilities | null
  /** 它的声明里核心自己要用的部分（认识哪些扩展、有哪几档权限预设）。没有声明是 null */
  terms(harness: HarnessId, sessionId?: string): HarnessTerms | null
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
  /** 已载入的实时回合状态改变，同步侧栏摘要，不依赖另一条状态广播的到达顺序。 */
  turnStateChanged?(sessionId: string, running: boolean): void
  rememberCapabilities?(thread: Thread): void
  threadScoped?(sessionId: string): boolean
  agentParent?(sessionId: string): string | null
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
  /** 设备记着的这个会话的子代理（载入会话时放进快照，之后的变化经 setAgents 来） */
  agentsOf?(sessionId: string): AgentThreadView[]
  /**
   * 直连原生 codex 时按会话记速度的地方（codex 不保存速度，protocol 包的 codex-speeds.mts）。
   * 只在对面就是原生 codex 自己时用；连的是设备服务时由设备进程记。不给就不记
   */
  speeds?: SpeedStore
  /** 会话视图存在这台电脑上的那一份（view-store.mts）：离开、回合结束时存，打开时先摆出来。不给就不存 */
  views?: ViewStore
  pendingInputs?: import('./pending-inputs.mjs').PendingInputStore
  log(line: string): void
}

export interface LiveSessions {
  managerStatus(sessionId: string, status: Manager['status']): void
  loadOlder(sessionId: string): Promise<void>
  recover(sessionId: string, turnId: string, text?: string): Promise<void>
  open(sessionId: string, sink: HostSink): () => void
  /** 界面上有没有人开着这个会话 */
  watched(sessionId: string): boolean
  /** 核心手里这个会话的视图（开着的、刚关上还留着的）。没有是 null */
  view(sessionId: string): SessionView | null
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
    /**
     * message 的文字是持续目标：建好会话后设下目标（thread/goal/set），不开回合，harness 空闲时自己开始做。
     * 强度、协作模式这些要跟着回合发的设置，这时到用户第一次自己发消息才带过去
     */
    asGoal?: boolean,
    /** 在新工作树里建：设备先建工作树再起会话（worktrees 扩展），会话的目录是工作树里对应的子目录 */
    worktree?: { from?: WorktreeFrom },
  ): Promise<string>
  /** 在 harness 上新建会话时会带上的客户端工具定义（create 用的同一份）；不带是空的 */
  toolsFor(harness: HarnessId | null): unknown[]
  /** 改模型、强度、权限预设。记在这边，下一个回合开始时一起告诉对面 */
  configure(sessionId: string, settings: Partial<SessionSettings>): void
  /** 执行计划：退出计划模式，并以 text 这句话发起一个回合。回合还在进行的时候做不了 */
  implementPlan(sessionId: string, text: string): Promise<void>
  /** now：有回合在进行时直接插进去（引导），插不进去就照常排队 */
  send(
    sessionId: string,
    message: OutgoingMessage,
    now?: boolean,
    pending?: 'include' | 'only',
  ): Promise<void>
  resumeQueue(sessionId: string, messageId?: string): Promise<void>
  /** 发不出去的消息放进队尾、写一句为什么，等用户处理（同排队的消息发不出去时） */
  hold(sessionId: string, message: OutgoingMessage, error: unknown): void
  /** 把一条排着队的消息现在就插进正在进行的回合里 */
  steer(sessionId: string, messageId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** 停掉一个后台命令：列出会话的后台终端，按进程标识或发起它的条目认出来，再 terminate */
  stopBackground(sessionId: string, taskId: string, itemId: string | null): Promise<void>
  unqueue(sessionId: string, messageId: string): void
  respond(sessionId: string, requestId: string, choice: RequestChoice): void
  /**
   * 从 turnId 这个回合（含）分叉出一个新会话，返回新会话的标识。
   * itemId：这个回合只带到插进去的这条用户消息之前（界面里的条目标识）
   */
  fork(sessionId: string, turnId: string, itemId?: string): Promise<string>
  /**
   * 侧聊：从这个会话临时分出一个会话（thread/fork 带 ephemeral），返回它的标识。带着到最近一个结束了的回合为止的上下文；
   * 有回合在跑时截在它之前（主会话不受影响）。新会话不进侧栏，没人订阅一阵后对面就卸载了
   */
  sideChat(sessionId: string): Promise<string>
  /** 把 turnId 这个回合和它后面的都撤掉；带 itemId 时这一回合只撤掉这条插进去的话和它之后的 */
  rollback(sessionId: string, turnId: string, itemId?: string): Promise<void>
  /** 普通压缩受理就返回；带设置时等压缩成功再应用设置并返回。 */
  compact(sessionId: string, thenConfigure?: Partial<SessionSettings>): Promise<void>
  /** 设、改持续目标（thread/goal/set，origin 是 user）。受理了就返回，新的样子随后由通知带来 */
  setGoal(sessionId: string, change: GoalChange): Promise<void>
  /** 清掉持续目标 */
  clearGoal(sessionId: string): Promise<void>
  /**
   * 用户答了一张提案（开始、不要，offer 卡上选新会话、在这里做）：开着的会话里先改成答过的样子，
   * 不等设备进程的通知。chosen 还没了结（等模型补简报），不记了结的时间
   */
  settleProposal(
    sessionId: string,
    proposalId: string,
    status: 'started' | 'dismissed' | 'chosen' | 'here',
    startedId: string | null,
  ): void
  /** 这个会话的子代理列表变了（设备记着的子线程和它们的回合）：开着的话交给界面 */
  setAgents(sessionId: string, agents: AgentThreadView[]): void
}

interface Waiting extends PendingRequest {
  resolve(result: unknown): void
}

interface Live {
  managerRevision: number
  recoveryRevision: number
  id: string
  sinks: Set<HostSink>
  /** null：还没载入成功 */
  view: SessionView | null
  loading: Cancel | null
  historyCursor: string | null
  paging: Cancel | null
  pageJob: Promise<void> | null
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
  immediate: Set<string>
  withdrawn: Set<string>
  paused: boolean
  /** 区分“点击恢复之前已暂停”和“等待对账期间发生的新暂停”。 */
  pauseRevision: number
  /** 插话被明确拒为没有活动回合；核实状态前不能再按旧视图发送。 */
  needsTurnCheck: boolean
  dispatching: QueuedMessage[]
  /** 回合号到达之前的停止在这里等待；本地回合已保留输入正文。 */
  startingInput: Map<string, { ready: Promise<string | null>; resolve(id: string | null): void }>
  /** 用户改了、还没告诉对面的设置 */
  pending: Partial<SessionSettings>
  /**
   * 插进回合里、对面还没回显的话：发出去时带的客户端标识 → 先显示出来的那个条目。
   * 声明交付状态的引擎在 sent 才移除；queued 仍保留原文，停止时按明确回执结算。
   */
  steered: Map<string, { key: string; turnId: string; message: OutgoingMessage; tracked?: boolean }>
  /** 我们自己发出的回退还没回来。这期间对面的“历史被改写了”通知说的就是这一次，不用重新载入 */
  reverting: boolean
  /** 回退途中已经收到了对面的“历史被改写了” */
  revertEchoed: boolean
  /**
   * 回退的应答先到、通知后到时，到这个时刻之前来的第一条“历史被改写了”说的还是这一次，不再载入。
   * 编辑重发紧接着就发新回合，再载入一遍会和它撞上（新回合被载入回来的历史盖掉）
   */
  revertEchoUntil: number
  /** 这边发出的手动压缩里，对面还没开始压的几次：接下来开始的压缩算手动的（官方桌面端也这样认） */
  compacting: number
  /** 压缩确认成功之后才切供应商；同时拦住队列，免得下一条抢先使用旧型号。 */
  compactSwitch?: {
    turnId: string | null
    completed: boolean
    resolve(): void
    reject(error: unknown): void
  }
  /**
   * 手里的视图是旧的：没人看着时连接断过（或者它的 harness 断过），订阅已经没了、没重新载入。
   * 再打开时先摆它（标 stale），同时重新载入
   */
  stale: boolean
}

type Notes = {
  [M in keyof ServerNotifications]?: (live: Live, params: ServerNotifications[M]) => void
}

const LOAD_TIMEOUT = 60_000

/**
 * 没人看了的会话视图和订阅再留多久、每台设备最多留几个（最近离开的在前）：切回来直接画，不用再拉一遍整份历史。
 * 远程设备上拉一份长会话要几秒到几十秒（2026-10-28 的日志：中位数 0.9 秒，p90 4.8 秒）
 */
const LINGER_MS = 10 * 60_000
const LINGER_MAX = 6

/** 自己回退之后多久之内来的“历史被改写了”算这一次的回音（Live.revertEchoUntil） */
const REVERT_ECHO_MS = 5000
/** 在新工作树里建会话最多等多久 */
const WORKTREE_TIMEOUT = 10 * 60_000
/** 按停止时先暂停目标，最多等这么久（官方桌面端也是 500 毫秒） */
const PAUSE_BEFORE_STOP_MS = 500

const isRunning = (view: SessionView): TurnView | undefined =>
  view.turns.findLast((turn) => turn.status === 'running')

const UNSUPPORTED = '对方不支持此操作'

export function createLiveSessions(host: LiveHost): LiveSessions {
  // 来自设备经理状态，不依赖当前打开的是经理页还是普通详情页。
  const managerStates = new Map<string, Manager['status']>()
  const managerNote = (id: string) => {
    const status = managerStates.get(id)
    return status === 'ending'
      ? phrase('manager.endingNote')
      : status === 'ended'
        ? phrase('manager.readOnly')
        : null
  }
  const sessions = new Map<string, Live>()
  /** 没人看了、还留着的会话（插入的先后就是离开的先后）→ 到点放掉的取消函数 */
  const lingering = new Map<string, () => void>()
  /**
   * 建会话、恢复、分叉、发回合都经这里：直连原生 codex 时记下选过的速度，恢复、分叉没带时补回
   * （protocol 包的 codex-speeds.mts）。连的是设备服务、适配器时照发，设备进程那边自己记
   */
  const withSpeed = <M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']> => {
    const store = host.sole() === 'codex' ? host.speeds : undefined
    const prepared = store
      ? prepareSpeed(method, params as unknown as Record<string, unknown>, store)
      : null
    if (!prepared) return host.request(method, params, options)
    const ready = prepared.params as unknown as ClientRequests[M]['params']
    return host.request(method, ready, options).then((result) => {
      prepared.remember(result)
      return result
    })
  }
  /** 刚分出来的侧聊：第一条消息开头还要拼上给模型的边界说明（projection/side-chat.mts），发出去了就拿掉 */
  const noted = new Set<string>()
  /** 说明拼在正文那一段前面；只有图片、技能的消息补一段正文（放在技能后面：技能那一句要在话的开头） */
  const withNote = (input: UserInput[]): UserInput[] => {
    const at = input.findIndex((part) => part.type === 'text')
    if (at >= 0) {
      const part = input[at] as Extract<UserInput, { type: 'text' }>
      return input.map((each, index) =>
        index === at ? { ...part, text: withSideChatNote(part.text) } : each,
      )
    }
    const skills = input.filter((part) => part.type === 'skill').length
    const note: UserInput = { type: 'text', text: withSideChatNote(''), text_elements: [] }
    return [...input.slice(0, skills), note, ...input.slice(skills)]
  }
  let localSeq = 0
  /**
   * 这次运行的记号，拼进发给对面的消息号里。localSeq 每次启动从 0 数起，入口按“会话 + 消息号”永久记账
   * （同一个号换了内容就拒），只用序号的话重启后在老会话里会撞上以前用过的号
   */
  const runMark = `${host.clock.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
  const abilities = (harness: HarnessId, sessionId?: string): SessionAbilities => {
    const lacks = lacking.get(
      sessionId && host.threadScoped?.(sessionId) ? `${harness}:${sessionId}` : harness,
    )
    const declared = host.declared(harness, sessionId)
    const can = (ability: SessionAbility): boolean =>
      (declared ? declared[ability] : true) && !lacks?.has(ability)
    return {
      ...(declared
        ? { images: declared.images, skills: declared.skills, mentions: declared.mentions }
        : {}),
      fork: can('fork'),
      rollback: can('rollback'),
      compact: can('compact'),
      steer: can('steer'),
      steerImages: declared ? declared.steerImages : true,
      rollbackRestoresFiles: declared ? declared.rollbackRestoresFiles : false,
      cutInTurn: declared?.cutInTurn === true,
      finalOnStart: declared ? declared.finalOnStart : false,
      backgroundTasks: declared ? declared.backgroundTasks : false,
      // 持续目标只认声明，没有声明的不先当它会（入口出来了也只能告诉人做不了）
      goals: declared?.goals === true && !lacks?.has('goals'),
      sideChat: declared?.ephemeralFork === true && can('fork'),
      declared: declared !== null,
    }
  }

  /** 这个会话所在的 harness 收不收指向文件的 mention。没有声明的按不收算：路径写进正文，谁都读得到 */
  const mentionsIn = (live: Live): boolean =>
    live.view ? host.declared(live.view.harness, live.id)?.mentions === true : false

  /** 对面说它不会这件事：记下来，告诉这个 harness 上所有开着的会话 */
  const markLacking = (harness: HarnessId, ability: SessionAbility, sessionId?: string) => {
    const scoped = sessionId && host.threadScoped?.(sessionId)
    const key = scoped ? `${harness}:${sessionId}` : harness
    const lacks = lacking.get(key) ?? new Set<SessionAbility>()
    lacks.add(ability)
    lacking.set(key, lacks)
    for (const other of sessions.values()) {
      if (other.view?.harness === harness && (!scoped || other.id === sessionId))
        emit(other, [{ op: 'session.can', can: abilities(harness, other.id) }])
    }
  }

  /** 这个 harness 声明的权限预设。没有声明是 null，按内置的三档 */
  const presetsOf = (harness: HarnessId, sessionId?: string) =>
    host.terms(harness, sessionId)?.presets ?? null

  /**
   * 审批请求按什么条件画。“拒绝并附说明”要三样都有才给入口：这条连接声明了（握手时我们一律声明，
   * 见 link.mts）、会话所属的 harness 声明了、这次请求的决定列表里真有这一项（最后一样在 requests.mts 里看）
   */
  const requestTerms = (harness: HarnessId, sessionId?: string): RequestTerms => ({
    declineWithNote:
      host.terms(harness, sessionId)?.extensions.includes(EXTENSION.declineWithNote) === true,
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
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    const owner = ownerOf(live)
    if (owner !== null && !host.ready(owner)) throw harnessDownError(host.harnessName(owner))
  }

  /**
   * 一批增量：先落到这边的视图上，再交给订阅的各方。
   * 增量是值：视图里放的是拷出来的一份（见 reduce.mts），交出去的这些对象之后不会再被这边改动
   */
  const emit = (live: Live, given: SessionOp[]) => {
    const view = live.view
    if (!view || given.length === 0) return
    // 添加条目的那几条记上看到它开始、结束的时刻（步骤组的时长用），再落到视图上
    const now = host.clock.now()
    const readonlyNote = managerNote(live.id)
    const ops = given.map((op) => {
      const guarded =
        readonlyNote && op.op === 'session.state' ? { ...op, live: false, note: readonlyNote } : op
      const stamped = spanOp(view, guarded, now)
      reduceSession(view, stamped)
      return stamped
    })
    const inputChanged = ops.some(
      (op) => op.op === 'queue.set' || (op.op === 'item.add' && op.item.kind === 'userMessage'),
    )
    if (inputChanged) persistInputs(live)
    if (inputChanged || ops.some((op) => op.op === 'history.prepend' || op.op === 'turn.add')) {
      const removed = withdrawnInputOps(view, live.withdrawn)
      for (const op of removed) reduceSession(view, op)
      ops.push(...removed)
    }
    for (const sink of live.sinks) sink.delta(ops)
    if (view.live && ops.some((op) => op.op === 'turn.add' || op.op === 'turn.status'))
      host.turnStateChanged?.(live.id, Boolean(isRunning(view)))
  }

  const persistInputs = (live: Live): boolean => {
    if (!host.pendingInputs) return true
    const inFlight: QueuedMessage[] = [...live.steered]
      .filter(([clientId]) => !live.queued.some((entry) => entry.clientId === clientId))
      .map(([clientId, entry]) => ({
        ...entry.message,
        id: clientId,
        clientId,
        delivery: 'unknown',
      }))
    const withdrawn = new Set(live.withdrawn)
    for (const entry of live.queued) {
      if (entry.sourceClientId) withdrawn.add(entry.sourceClientId)
    }
    try {
      // 原文和撤回身份同一次原子写入，失败时不能隐藏原位唯一的持久副本。
      host.pendingInputs.save(
        live.id,
        [...inFlight, ...live.dispatching, ...live.queued],
        [...withdrawn],
      )
      live.withdrawn = withdrawn
      return true
    } catch (error) {
      setNote(live, phrase('session.queueFailed', { message: String(error) }))
      return false
    }
  }

  const pauseQueue = (live: Live) => {
    live.immediate.clear()
    live.pauseRevision++
    live.paused = true
    // 先按插话原顺序占位，取消回执只改状态；否则后排的普通消息会跑到退回插话前面。
    const uncertain: QueuedMessage[] = [...live.steered]
      .filter(
        ([clientId, entry]) =>
          entry.tracked && !live.queued.some((message) => message.clientId === clientId),
      )
      .map(([clientId, entry]) => ({
        ...entry.message,
        id: clientId,
        clientId,
        delivery: 'unknown',
      }))
    live.queued = [...uncertain, ...live.queued]
    live.queued = live.queued.map((entry) => ({ ...entry, delivery: entry.delivery ?? 'held' }))
    emit(live, [{ op: 'queue.set', queued: live.queued }])
  }

  const releaseInput = (entry: QueuedMessage): QueuedMessage => {
    const { delivery: _delivery, clientId: _clientId, ...message } = entry
    return message
  }

  const reconcileInput = (live: Live, item: ThreadItem) => {
    if (item.type !== 'userMessage' || !item.clientId) return
    const status = inputDelivery(item) ?? 'sent'
    const existing = live.queued.find((entry) => entry.clientId === item.clientId)
    if (status === 'sent' && existing) {
      live.queued = live.queued.filter((entry) => entry !== existing)
    } else if (existing && (status === 'held' || status === 'unknown')) {
      live.queued = live.queued.map((entry) =>
        entry === existing
          ? {
              ...entry,
              delivery: status,
              ...(status === 'held' ? { sourceClientId: item.clientId! } : {}),
            }
          : entry,
      )
    } else return
    emit(live, [{ op: 'queue.set', queued: live.queued }])
  }

  const viewTurn = (live: Live, turnId: string): string => live.alias.get(turnId) ?? turnId

  /** 条目在界面里的标识 */
  const viewItem = (live: Live, viewId: string, itemId: string, index = 0): string => {
    const key = itemKey(viewId, itemId, index)
    return live.itemAlias.get(key) ?? key
  }

  /**
   * 切在回合中间时发给对面的条目标识：界面里回合 viewId 的条目 key 换回协议里的条目标识。
   * 先显示出来、对面还没回显的（还没对上标识的）、不是插进去的用户消息的、会话不会切在回合中间的，都不行
   */
  const cutAt = (live: Live & { view: SessionView }, viewId: string, key: string): string => {
    if (!live.view.can.cutInTurn) throw new ChannelError('unsupported', UNSUPPORTED)
    const turn = live.view.turns.find((entry) => entry.id === viewId)
    const item = live.view.items[key]
    if (!turn || item?.kind !== 'userMessage' || turn.itemIds.indexOf(key) < 1)
      throw new ChannelError('rejected', '这条消息不是插进这个回合的话')
    let own = key
    for (const [from, to] of live.itemAlias) {
      if (to === key) {
        own = from
        break
      }
    }
    const id = own.startsWith(`${viewId}:`) ? own.slice(viewId.length + 1) : ''
    if (!id || id.startsWith('#') || id.startsWith('steer:'))
      throw new ChannelError('rejected', '这条消息还没被对面收下，稍后再试')
    return id
  }

  /** 协议里的回合标识。本机刚发出、对面还没给标识的回合返回 null */
  const serverTurn = (live: Live, viewId: string): string | null => {
    for (const [server, view] of live.alias) if (view === viewId) return server
    return viewId.startsWith('local:') ? null : viewId
  }

  /**
   * 对面没说来历的续跑回合（原生 codex）：会话有目标、回合里没有用户消息、模型说了话的，记成 goal，
   * 开头那一行据此写“继续推进目标”。本机发出的回合不算
   */
  const markGoalTurn = (live: Live, viewId: string) => {
    const view = live.view
    // 达成目标的那一轮结束时目标已经清掉了，它也算
    const pursued = view?.goal || view?.goalReached?.turnId === viewId
    if (!view || !pursued || !view.can.goals || viewId.startsWith('local:')) return
    const turn = view.turns.find((entry) => entry.id === viewId)
    if (!turn || turn.status === 'running' || !looksLikeGoalTurn(turn, view.items)) return
    emit(live, [
      {
        op: 'turn.status',
        turnId: viewId,
        status: turn.status,
        durationMs: turn.durationMs,
        origin: 'goal',
      },
    ])
  }

  /**
   * 目标达成了（照官方桌面端）：清掉它（thread/goal/clear，不带 origin：不算用户改了目标，不记进模型的上下文），
   * 输入框上方那一行马上收起，改在达成它的回合（通知带着；没带就是最后一个回合）的回答下面写用了多久。
   * 同一个会话开着几个客户端时各自都会清一次，后清的回 cleared: false，没有关系
   */
  const reachGoal = (live: Live, goal: SessionGoalView, turnId: string | null | undefined) => {
    const view = live.view
    if (!view) return
    const turn = turnId ? viewTurn(live, turnId) : view.turns.at(-1)?.id
    // 已经收过这一次了（载入时问到的和恢复后对面补的那条是同一个）
    if (!view.goal && turn && view.goalReached?.turnId === turn) return
    emit(live, [
      { op: 'session.goal', goal: null },
      {
        op: 'session.goalReached',
        reached: turn
          ? { turnId: turn, objective: goal.objective, timeUsedSeconds: goal.timeUsedSeconds }
          : null,
      },
    ])
    clearReached(live)
  }

  const clearReached = (live: Live) =>
    host
      .request('thread/goal/clear', { threadId: live.id }, { timeoutMs: LOAD_TIMEOUT })
      .catch((error: unknown) => host.log(`清掉会话 ${live.id} 已达成的目标没成：${String(error)}`))

  /** 对面第一次提到一个回合：如果本机正好有一个刚发出去的回合在等标识，就是它 */
  const bind = (live: Live, turnId: string): string => {
    const known = live.alias.get(turnId)
    if (known) return known
    if (live.starting && !live.view?.turns.some((turn) => turn.id === turnId)) {
      live.alias.set(turnId, live.starting)
      const viewId = live.starting
      live.starting = null
      live.startingInput.get(viewId)?.resolve(turnId)
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
      const projected = projectTurn(turn, viewId, ownerOf(live) === 'codex')
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
        ...originOf(turn),
      },
    ]
    if (turn.status !== 'inProgress') {
      // Codex 的完成事件会带最后一条回答；条目流未送到这条连接时仍须补齐。
      // 这里只合并事件实际携带的条目，不能用 summary/notLoaded 清空此前的过程。
      for (const item of turn.items ?? []) {
        if (item.type !== 'agentMessage') continue
        const key = viewItem(live, viewId, item.id)
        ops.push({
          op: 'item.add',
          turnId: viewId,
          item: { ...projectItem(item, false, ownerOf(live) === 'codex'), id: key },
        })
      }
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
    const current = live.view?.turns.find((turn) => turn.id === viewId)
    // 续跑回合里入口替 harness 说的那句“接着做”不画成用户消息（和载入时一样，projectTurn）
    if (item.type === 'userMessage' && current?.origin === 'goal') {
      if (current.hiddenInputId === item.id) return
      // 入口也可以先报空回合，再回显代发输入。记住其标识，后续补充不再按来源一概过滤。
      if (!current.hiddenInputId && current.itemIds.length === 0) {
        emit(live, [{ op: 'turn.add', turn: { ...current, hiddenInputId: item.id } }])
        return
      }
    }
    const ops = ensureTurn(live, viewId)
    const position = live.view?.turns.find((turn) => turn.id === viewId)?.itemIds.length ?? 0
    // 对面回显了本机先显示出来的消息：落在同一个条目上，不多出一条。
    // 插进回合里的话按发出去时带的标识认；回合的第一条消息按“这个回合里第一条用户消息”认
    let echoed: string | undefined
    if (item.type === 'userMessage') {
      const previous = live.view?.items[viewItem(live, viewId, item.id, position)]
      if (
        previous?.kind === 'userMessage' &&
        previous.delivery === 'sent' &&
        inputDelivery(item) &&
        inputDelivery(item) !== 'sent'
      )
        return
      if (
        item.clientId &&
        live.withdrawn.has(item.clientId) &&
        inputDelivery(item) !== 'sent' &&
        inputDelivery(item) !== 'held'
      )
        return
      reconcileInput(live, item)
      const own = itemKey(viewId, item.id, position)
      const steered = item.clientId ? live.steered.get(item.clientId) : undefined
      if (steered && item.clientId) {
        echoed = steered.key
        const status = inputDelivery(item)
        if (status) steered.tracked = true
        if (status !== 'queued') live.steered.delete(item.clientId)
        if (
          (status === 'held' || status === 'unknown') &&
          !live.queued.some((entry) => entry.clientId === item.clientId)
        ) {
          live.pauseRevision++
          live.paused = true
          live.queued = [
            ...live.queued.filter((entry) => entry.delivery),
            {
              ...steered.message,
              id: item.clientId,
              clientId: item.clientId,
              delivery: status,
              ...(status === 'held' ? { sourceClientId: item.clientId } : {}),
            },
            ...live.queued.filter((entry) => !entry.delivery),
          ]
          emit(live, [{ op: 'queue.set', queued: live.queued }])
        }
      } else if (!live.itemAlias.has(own)) {
        // 已经对上过的条目（开始、完成各来一次）不再去认领别的
        echoed = live.echo.get(viewId)
        if (echoed) live.echo.delete(viewId)
      }
      if (echoed) live.itemAlias.set(own, echoed)
    }
    const key = echoed ?? viewItem(live, viewId, item.id, position)
    const view: ItemView = {
      ...projectItem(item, streaming, ownerOf(live) === 'codex'),
      id: key,
    }
    if (
      (view.kind === 'agentMessage' && view.questions?.length) ||
      (view.kind === 'toolCall' && view.wrapUp)
    )
      view.questionSource = questionSource(turnId, item.id || `#${position}`)
    if (view.kind === 'compaction') {
      if (
        live.compactSwitch &&
        (!live.compactSwitch.turnId || live.compactSwitch.turnId === turnId)
      ) {
        live.compactSwitch.turnId = turnId
        if (!streaming && view.status === 'completed') live.compactSwitch.completed = true
      }
      // 完成时沿用开始时定下的来源；头一次见到它时认一下是不是这边点的
      const seen = live.view?.items[key]
      if (seen?.kind === 'compaction') view.source = seen.source
      else if (live.compacting > 0) {
        live.compacting--
        view.source = 'manual'
      }
    }
    // 看着它开始的命令记下时刻：对面不增量给输出的时候，界面拿它显示“已经跑了多久”
    if (view.kind === 'command' && streaming && view.status === 'inProgress') {
      view.startedAt = host.clock.now()
    }
    ops.push({ op: 'item.add', turnId: viewId, item: view })
    emit(live, ops)
    // 自动压缩只结束条目，普通回合仍会继续；此时恢复用户留下的插话意图。
    if (view.kind === 'compaction' && !streaming) pump(live)
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
   * 声明交付状态但没有最终回执的插话保留待确认，禁止自动重发。
   * 其他引擎保留既有的未回显恢复判据，但改为暂停待发；正常结束不猜测重发。
   */
  const settleSteered = (live: Live, viewId: string, completed: boolean) => {
    const back: QueuedMessage[] = []
    const ops: SessionOp[] = []
    for (const [clientId, entry] of live.steered) {
      if (entry.turnId !== viewId) continue
      live.steered.delete(clientId)
      if (completed && !entry.tracked) continue
      const delivery = entry.tracked ? 'unknown' : 'held'
      const item = live.view?.items[entry.key]
      if (entry.tracked && item?.kind === 'userMessage')
        ops.push({ op: 'item.add', turnId: viewId, item: { ...item, delivery } })
      else ops.push({ op: 'item.remove', turnId: viewId, itemId: entry.key })
      if (!live.queued.some((message) => message.clientId === clientId))
        back.push({ id: clientId, clientId, ...entry.message, delivery })
    }
    if (back.length === 0) {
      if (ops.length) emit(live, ops)
      else persistInputs(live)
      return
    }
    live.queued = [...back, ...live.queued]
    live.pauseRevision++
    live.paused = true
    emit(live, [...ops, { op: 'queue.set', queued: live.queued }])
  }

  /** 回合结束了：对面没发“完成”的条目按回合的结局收尾，免得一直显示在跑（见 settledItem） */
  const settleItems = (live: Live, turnId: string, completed: boolean) => {
    const viewId = viewTurn(live, turnId)
    const view = live.view
    const turn = view?.turns.find((entry) => entry.id === viewId)
    if (!view || !turn) return
    const ops: SessionOp[] = []
    for (const itemId of turn.itemIds) {
      const current = view.items[itemId]
      const item = current ? settledItem(current, completed) : null
      if (item) ops.push({ op: 'item.add', turnId: viewId, item })
    }
    if (ops.length > 0) emit(live, ops)
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
      const thread = (threadSettings as typeof threadSettings & { thread?: Thread })?.thread
      if (thread) host.started(thread)
      if (live.view && thread) {
        emit(live, [
          { op: 'session.can', can: abilities(live.view.harness, live.id) },
          {
            op: 'session.settings',
            settings: projectSettings(threadSettings, presetsOf(live.view.harness, live.id)),
          },
        ])
      }
      const mode = projectMode(threadSettings?.collaborationMode?.mode)
      if (!mode || !live.view) return
      // 对面说了算：这边想改还没发出去的那一下不留着
      delete live.pending.mode
      if (live.view.settings.mode === mode) return
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, mode } }])
    },
    'turn/started': (live, { turn }) => {
      if (live.compactSwitch && !live.compactSwitch.turnId) live.compactSwitch.turnId = turn.id
      putTurn(live, turn)
    },
    'turn/completed': (live, { turn }) => {
      if (turn.status !== 'completed') pauseQueue(live)
      putTurn(live, turn)
      // 回合结束了，还在重试的那一句不留着（对面一般在结束前已经说过重试结束了）
      const viewId = viewTurn(live, turn.id)
      emit(live, [{ op: 'turn.recovery', turnId: viewId, recovery: null }])
      if (live.view?.turns.find((entry) => entry.id === viewId)?.retry)
        emit(live, [{ op: 'turn.retry', turnId: viewId, retry: null }])
      markGoalTurn(live, viewTurn(live, turn.id))
      settleItems(live, turn.id, turn.status === 'completed')
      settleTodo(live, turn.id)
      settleSteered(live, viewTurn(live, turn.id), turn.status === 'completed')
      // 手动压缩的回合结束了还没见到压缩条目（对面不发）：不留到以后，免得把下一次自动压缩认成手动的
      live.compacting = 0
      const switching = live.compactSwitch
      if (switching?.turnId === turn.id) {
        if (turn.status === 'completed' && switching.completed) switching.resolve()
        else
          switching.reject(
            new ChannelError(
              'rejected',
              '压缩未完成，未切换供应商',
              phrase('session.switchIncomplete'),
            ),
          )
      }
      // 阻塞请求的接收方随所属回合结束而撤销。其他回合的结束不能影响它；
      // wrap_up 和异步提问没有挂在此 RPC 表里，按明确答复单独保留。
      settleRequests(live, (request) => request.turnId === turn.id)
      host.touched(live.id)
      host.turnEnded?.(live.id, turn.id)
      // 后面的回合已经完成，前面却还显示在跑：补读权威历史，不能一直向旧回合插话。
      if (live.view && isRunning(live.view))
        void reconcileTurns(live).then((idle) => {
          if (idle) pump(live)
        })
      // 迟到的 idle 可能在下一轮启动时留下核实标记；所有已知回合已有明确终态后不再阻塞队列。
      else live.needsTurnCheck = false
      pump(live)
      // 开着的会话回合结束时也存一份：退出应用时开着的那个，下次打开也有东西先摆（没人看的在 release 里存）
      if (live.sinks.size > 0) remember(live)
      release(live)
    },
    'thread/status/changed': (live, { status }) => {
      if (status.type === 'idle' && live.view && isRunning(live.view))
        void reconcileTurns(live).then((idle) => {
          if (idle) pump(live)
        })
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
    // 模型请求在重试（apiRetry 扩展）：状态行写第几次和原因，重试结束时去掉。
    // 失败那次流出来的半截回答对面已经删了，这里也撤掉
    'litch/turn/apiRetry/updated': (live, { turnId, retry, discardedItemIds }) => {
      const viewId = viewTurn(live, turnId)
      const ops: SessionOp[] = (discardedItemIds ?? []).map((itemId) => ({
        op: 'item.remove',
        turnId: viewId,
        itemId: viewItem(live, viewId, itemId),
      }))
      if (retry || live.view?.turns.find((entry) => entry.id === viewId)?.retry)
        ops.push({
          op: 'turn.retry',
          turnId: viewId,
          retry: retry && {
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            reason: retry.reason,
            httpStatus: retry.httpStatus,
          },
        })
      emit(live, ops)
    },
    'litch/turn/recovery/changed': (live, { turnId, recovery }) => {
      const id = viewTurn(live, turnId)
      if (live.view?.turns.some((turn) => turn.id === id && turn.status === 'running'))
        emit(live, [{ op: 'turn.recovery', turnId: id, recovery }])
    },
    error: (live, { error, willRetry, turnId }) => {
      if (willRetry) {
        const id = viewTurn(live, turnId)
        if (live.view?.turns.some((turn) => turn.id === id && turn.status === 'running'))
          emit(live, [
            {
              op: 'turn.retry',
              turnId: id,
              retry: {
                attempt: null,
                maxRetries: null,
                reason: 'other',
                httpStatus: null,
                message: error.message,
              },
            },
          ])
      }
      // 不再重试的错误，随后的“回合结束”里带着同样的原因；这里只留个记录
      host.log(
        `会话 ${live.id} 的回合 ${turnId} 报错（${willRetry ? '会重试' : '不再重试'}）：${error.message}`,
      )
    },
    'serverRequest/resolved': (live, { requestId }) =>
      settleRequests(live, (request) => request.view.id === String(requestId)),
    // 会话的历史被改写了（别的客户端回退了它）：不知道撤掉了哪些，整个重新载入
    'thread/reverted': (live) => {
      if (live.reverting) {
        live.revertEchoed = true
        return
      }
      if (live.revertEchoUntil > host.clock.now()) {
        live.revertEchoUntil = 0
        return
      }
      load(live)
    },
    // 持续目标设了、改了（状态、用量）、清掉了。上游发给每条连接，这里只管打开着的会话；
    // 恢复会话时上游也会补一条现在的样子（有目标的话）
    'thread/goal/updated': (live, { goal, turnId }) => {
      const next = projectGoal(goal)
      if (next?.status === 'complete' && live.view?.can.goals) return reachGoal(live, next, turnId)
      // 设了新目标：上一个目标达成的那一句不再写（照官方桌面端）
      emit(live, [
        { op: 'session.goal', goal: next },
        ...(next && live.view?.goalReached
          ? [{ op: 'session.goalReached' as const, reached: null }]
          : []),
      ])
    },
    'thread/goal/cleared': (live) => emit(live, [{ op: 'session.goal', goal: null }]),
    // 导进来的会话被别处的进程占上、放开了：占着时只能看，放开了恢复可写。别的原因只读的（归档、子代理）不动
    'litch/thread/nativeOwner/changed': (live, { owner }) => {
      const view = live.view
      if (!view) return
      const note = phrase('session.nativeOwned')
      if (owner && view.live) emit(live, [{ op: 'session.state', live: false, note }])
      else if (!owner && !view.live && typeof view.note === 'object' && view.note?.key === note.key)
        emit(live, [{ op: 'session.state', live: true, note: null }])
    },
    // 会话树：这个会话上的提案变了（新提、开始、不要、撤回、过期），带着现在全部等着的和刚变的那几条
    'litch/thread/questions/changed': (live, { ignoredQuestions }) =>
      emit(live, [{ op: 'session.ignoredQuestions', sourceIds: ignoredQuestions }]),
    'litch/thread/questionSettlements/changed': (live, { questionSettlements }) =>
      emit(live, [{ op: 'session.questionSettlements', records: questionSettlements }]),
    'litch/sessionProposal/changed': (live, { proposals, changed }) => {
      if (!live.view) return
      const merged = mergeProposals(live.view.proposals, proposals, changed ?? [], host.clock.now())
      emit(live, [{ op: 'session.proposals', proposals: merged }])
    },
  }

  // ---------- 载入与释放 ----------

  const failure = (error: unknown): ChannelError => channelFailure(error, host.harnessName)

  const cancelPage = (live: Live) => {
    live.paging?.abort()
    live.paging = null
    live.pageJob = null
    if (live.view?.history?.loading)
      emit(live, [{ op: 'session.history', history: { ...live.view.history, loading: false } }])
  }

  const fetchView = async (live: Live, cancel: Cancel): Promise<SessionView> => {
    const scope = (thread: Thread) => {
      host.rememberCapabilities?.(thread)
      return { deviceId: host.deviceId, harness: host.harnessFor(thread) }
    }
    const options = { timeoutMs: LOAD_TIMEOUT, signal: cancel.signal }
    live.historyCursor = null
    const paged = (thread: Thread, cursor: string | null): SessionView => {
      if (!cancel.signal.aborted) live.historyCursor = cursor
      return {
        ...projectThread(thread, scope(thread)),
        history: { hasMore: cursor !== null, loading: false, error: null },
      }
    }
    const readOnly = async () => {
      try {
        const { thread } = await host.request(
          'thread/read',
          { threadId: live.id, includeTurns: false },
          options,
        )
        if (thread.turns?.length) return projectThread(thread, scope(thread))
        const page = await host.request(
          'thread/turns/list',
          {
            threadId: live.id,
            ...INITIAL_HISTORY.initialTurnsPage,
          },
          options,
        )
        const first = historyPage(thread, page)
        return paged(first.thread, first.cursor)
      } catch (error) {
        if (!lacksPaging(error)) throw error
        const { thread } = await host.request(
          'thread/read',
          { threadId: live.id, includeTurns: true },
          options,
        )
        return projectThread(thread, scope(thread))
      }
    }
    if (host.shelved(live.id)) {
      // 归档着的会话：只取历史来看，不恢复、不订阅。要接着聊得先把它放回来
      return {
        ...(await readOnly()),
        live: false,
        note: phrase('session.archived'),
      }
    }
    try {
      let paging = true
      let resumed = await resumeAfterRecovery(
        async () => {
          try {
            return await withSpeed(
              'thread/resume',
              { threadId: live.id, ...INITIAL_HISTORY },
              options,
            )
          } catch (error) {
            // 重置拒绝不是分页参数不支持；保留事件驱动恢复，不立刻再撞一次相同拒绝。
            if (isManagerResetWaiting(error) || !lacksPaging(error)) throw error
            paging = false
            return withSpeed('thread/resume', { threadId: live.id }, options)
          }
        },
        host.clock,
        cancel.signal,
      )
      let first = paging ? initialHistory(resumed) : null
      // 有些端支持 excludeTurns，但还没有 initialTurnsPage。不能把空 turns 当成空历史。
      if (paging && !first && !resumed.thread.turns?.length) {
        try {
          first = historyPage(
            resumed.thread,
            await host.request(
              'thread/turns/list',
              {
                threadId: live.id,
                ...INITIAL_HISTORY.initialTurnsPage,
              },
              options,
            ),
          )
        } catch (error) {
          if (!lacksPaging(error)) throw error
          resumed = await withSpeed('thread/resume', { threadId: live.id }, options)
        }
      }
      const thread = first?.thread ?? resumed.thread
      for (const turn of thread.turns ?? [])
        for (const item of turn.items) reconcileInput(live, item)
      const view = first ? paged(thread, first.cursor) : projectThread(thread, scope(thread))
      return {
        ...view,
        settings: projectSettings(resumed, presetsOf(view.harness, live.id)),
        proposals: await proposalsOf(live.id, options),
        goal: await goalOf(live.id, view.harness, options),
      }
    } catch (error) {
      // 只有对面明确说“订阅不了”才退回去只取历史；断线、超时照常报错。
      // 它所属的 harness 不可用也不是“订阅不了”：只读地取同样取不到，等它恢复再载入
      // 恢复重试耗尽也应报载入失败，让界面可重试，不能生成永久只读视图。
      if (!(error instanceof RpcError) || isHarnessDown(error) || isSessionRecovering(error))
        throw error
      host.log(`订阅会话 ${live.id} 失败，改为只读载入：${error.message}`)
      return {
        ...(await readOnly()),
        live: false,
        // 被别处的 codex 用着：说清楚是怎么回事、该怎么办，不甩一句原话
        note: isManagerResetWaiting(error)
          ? phrase('manager.resetWaiting')
          : isHeldElsewhere(error)
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

  /**
   * 会话的持续目标。harness 不会的不问；问的时候对面说没有这个方法、或者关着这个特性（原生 codex 的配置里
   * 关了 goals），记成这个 harness 不会。问不到的当没有：目标不是看会话的必需品，之后的通知照样会带来
   */
  const goalOf = async (
    threadId: string,
    harness: HarnessId,
    options: RpcRequestOptions,
  ): Promise<SessionGoalView | null> => {
    if (!abilities(harness, threadId).goals) return null
    try {
      const { goal } = await host.request('thread/goal/get', { threadId }, options)
      return projectGoal(goal)
    } catch (error) {
      if (!(error instanceof RpcError) || isHarnessDown(error)) throw error
      if (lacksMethod(error) || goalsOff(error))
        markLacking(deviceFault(error)?.harness ?? harness, 'goals', threadId)
      else host.log(`取会话 ${threadId} 的目标失败：${error.message}`)
      return null
    }
  }

  /** 重新载入会话。返回的承诺在载入完（或放弃）时落定，不会失败 */
  const load = (live: Live): Promise<void> => {
    const managerRevision = live.managerRevision
    cancelPage(live)
    for (const [clientId, entry] of live.steered) {
      if (!entry.tracked) continue
      live.steered.delete(clientId)
      if (!live.queued.some((message) => message.clientId === clientId))
        live.queued.push({ ...entry.message, id: clientId, clientId, delivery: 'unknown' })
    }
    live.loading?.abort()
    const cancel = createCancel()
    live.loading = cancel
    live.held = []
    return fetchView(live, cancel).then(
      (view) => {
        if (cancel.signal.aborted) return
        live.loading = null
        const reached = live.view?.goalReached ?? null
        live.alias.clear()
        live.echo.clear()
        live.itemAlias.clear()
        live.summarized.clear()
        live.starting = null
        live.stale = false
        live.view = {
          ...view,
          ...(managerNote(live.id) ? { live: false, note: managerNote(live.id) } : {}),
          queued: live.queued,
          settings: { ...view.settings, ...live.pending },
          // 重新载入时对面不一定再报一遍，先留着上一次的
          usage: view.usage ?? live.view?.usage ?? null,
          can: abilities(view.harness, live.id),
          agents: host.agentsOf?.(live.id) ?? [],
        }
        if (!isRunning(live.view)) live.needsTurnCheck = false
        const kept = todos.get(live.id)
        if (kept) placeTodos(live.view, kept)
        // 目标达成的那一句是这边记的，对面的历史里没有：回合还在就留着
        if (reached && live.view.turns.some((turn) => turn.id === reached.turnId))
          live.view.goalReached = reached
        // 有目标的会话里对面没说来历的续跑回合（原生 codex），和看着它结束时一样认出来
        if ((live.view.goal || live.view.goalReached) && live.view.can.goals) {
          for (const turn of live.view.turns) {
            if (turn.status !== 'running' && looksLikeGoalTurn(turn, live.view.items))
              turn.origin = 'goal'
          }
        }
        // 请求走独立的 RPC 通道，不在历史快照里。resume 重放可能早于快照，已收到的请求都要保留。
        for (const waiting of live.requests.values()) {
          if (waiting.view.kind !== 'clientAsk' && waiting.turnId && waiting.itemId) {
            const key = viewItem(live, viewTurn(live, waiting.turnId), waiting.itemId)
            waiting.view = { ...waiting.view, itemId: live.view.items[key] ? key : null }
          }
          if (!live.view.requests.some((request) => request.id === waiting.view.id)) {
            live.view.requests.push(waiting.view)
          }
        }
        // 没人看着的时候达成的目标：现在照样清掉、在最后一个回合下面写用时（快照里就不带它，不闪一下）
        const done = live.view.goal?.status === 'complete' ? live.view.goal : null
        const last = live.view.turns.at(-1)?.id
        if (done && live.view.can.goals) {
          live.view.goal = null
          live.view.goalReached = last
            ? { turnId: last, objective: done.objective, timeUsedSeconds: done.timeUsedSeconds }
            : null
          clearReached(live)
        }
        persistInputs(live)
        for (const op of withdrawnInputOps(live.view, live.withdrawn)) reduceSession(live.view, op)
        for (const sink of live.sinks) sink.snapshot(live.view)
        const held = live.held
        live.held = []
        for (const entry of held) deliver(live, entry.method, entry.params, true)
        // 打开正在跑的会话时，目录可能还留着载入前的空闲摘要。只用确定的运行回合补状态；
        // 历史分页中没有运行回合不代表整个会话已结束，不能据此清除目录状态。
        if (live.view.live && isRunning(live.view)) host.turnStateChanged?.(live.id, true)
        // ready/取消通知可能先于被拒订阅的只读快照到达；这次载入结束后补订阅。
        if (
          !live.view.live &&
          managerRevision !== live.managerRevision &&
          managerStates.get(live.id) === 'active' &&
          !host.shelved(live.id)
        ) {
          void load(live)
          return
        }
        pump(live)
        if (host.recoverySupported?.()) {
          const revision = live.recoveryRevision
          void host
            .request('litch/device/recovery/read', {})
            .then(({ notices }) => {
              if (live.recoveryRevision !== revision || live.loading || live.stale) return
              for (const notice of notices)
                if (notice.threadId === live.id)
                  deliver(live, 'litch/turn/recovery/changed', notice)
            })
            .catch((error) => host.log(`读取回合恢复状态失败：${String(error)}`))
        }
        release(live)
      },
      (error: unknown) => {
        if (cancel.signal.aborted) return
        live.loading = null
        settleRequests(live, () => true)
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

  /**
   * 没人看、也没有在跑的事了：存一份视图，再留一阵（LINGER_MS），这期间切回来直接画；到点或者留的太多了才退订并放掉。
   * 留着的照样收对面的通知、视图跟着变，只是没有界面在看（watched 为假，未读、通知照旧按没人看算）
   */
  const release = (live: Live) => {
    if (live.sinks.size > 0 || live.loading || live.compactSwitch) return
    if (live.view && (isRunning(live.view) || live.requests.size > 0 || live.queued.length > 0))
      return
    if (!live.view) {
      drop(live)
      return
    }
    remember(live)
    unlinger(live.id)
    lingering.set(
      live.id,
      host.clock.setTimer(() => drop(live), LINGER_MS),
    )
    for (const id of lingering.keys()) {
      if (lingering.size <= LINGER_MAX) break
      const oldest = sessions.get(id)
      if (oldest) drop(oldest)
      else unlinger(id)
    }
  }

  /** 不再留：取消到点的计时 */
  const unlinger = (id: string) => {
    lingering.get(id)?.()
    lingering.delete(id)
  }

  /** 退订并放掉。期间又被打开、换成了别的、已经放掉了的不动 */
  const drop = (live: Live) => {
    unlinger(live.id)
    if (sessions.get(live.id) !== live || live.sinks.size > 0 || live.compactSwitch) return
    cancelPage(live)
    sessions.delete(live.id)
    // 够不着的时候不用退：订阅已经随连接（或者它的 harness 的上游连接）一起没了；旧的（stale）也一样
    if (live.view?.live && !live.stale && reachable(live)) {
      host.request('thread/unsubscribe', { threadId: live.id }).catch((error: unknown) => {
        host.log(`退订会话 ${live.id} 失败：${String(error)}`)
      })
    }
  }

  /** 这台电脑上存的那一份 */
  const recall = (id: string): SessionView | null => {
    try {
      return host.views?.load(id) ?? null
    } catch {
      return null
    }
  }

  /** 存一份视图到这台电脑上（裁过的；旧的、只读载入的不存） */
  const remember = (live: Live) => {
    if (!host.views || !live.view || live.stale || !live.view.live) return
    try {
      host.views.save(trimView(live.view))
    } catch (error) {
      host.log(`存会话 ${live.id} 的视图失败：${String(error)}`)
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
    let resolve!: (id: string | null) => void
    const ready = new Promise<string | null>((done) => {
      resolve = done
    })
    live.startingInput.set(viewId, { ready, resolve })
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
    const declared = live.view ? presetsOf(live.view.harness, live.id) !== null : false
    const overrides = turnOverrides(sent, declared, live.view?.settings)
    try {
      const { turn } = await withSpeed(
        'turn/start',
        {
          threadId: live.id,
          input: noted.has(live.id)
            ? withNote(toInput(message, mentions))
            : toInput(message, mentions),
          ...overrides,
          ...(clientId ? { clientUserMessageId: clientId } : {}),
        },
        { timeoutMs: LOAD_TIMEOUT },
      )
      noted.delete(live.id)
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
      resolve(null)
      if (live.starting === viewId) live.starting = null
      live.echo.delete(viewId)
      emit(live, [{ op: 'turn.remove', turnId: viewId }])
      throw failure(error)
    } finally {
      resolve(null)
      live.startingInput.delete(viewId)
    }
  }

  const setNote = (live: Live, note: SessionView['note']) => {
    if (live.view) emit(live, [{ op: 'session.state', live: live.view.live, note }])
  }

  /** 只读对账：idle 广播没有回合结局，不能据此把未完成的历史猜成成功。 */
  const reconcileTurns = async (live: Live): Promise<boolean> => {
    // 超时或被较新的通知作废后，下一次手动发送仍须核实；不能再次等待旧回合的结束通知。
    live.needsTurnCheck = true
    const view = live.view
    if (!view || live.loading || live.stale || live.starting || !reachable(live)) return false
    const revision = live.recoveryRevision
    const running = view.turns
      .filter((turn) => turn.status === 'running')
      .map((turn) => ({ viewId: turn.id, serverId: serverTurn(live, turn.id) }))
    try {
      const { thread } = await host.request(
        'thread/read',
        { threadId: live.id, includeTurns: !view.history },
        { timeoutMs: 5000 },
      )
      if (view.history) {
        // 长会话只核对回合头，不为几个状态拉回整份历史里的工具输出。
        const missing = new Set(
          running.flatMap((entry) => (entry.serverId ? [entry.serverId] : [])),
        )
        const uncertain = new Set(
          running.flatMap((entry) => {
            const turn = view.turns.find((turn) => turn.id === entry.viewId)
            return entry.serverId &&
              turn?.itemIds.some((id) => {
                const item = view.items[id]
                return (
                  item?.kind === 'userMessage' &&
                  (item.delivery === 'queued' || item.delivery === 'unknown')
                )
              })
              ? [entry.serverId]
              : []
          }),
        )
        const turns: Turn[] = []
        let cursor: string | null = null
        do {
          let page: ClientRequests['thread/turns/list']['result'] = await host.request(
            'thread/turns/list',
            {
              threadId: live.id,
              cursor,
              limit: 100,
              sortDirection: 'desc',
              itemsView: 'notLoaded',
            },
            { timeoutMs: 5000 },
          )
          if (page.nextCursor !== null && page.nextCursor === cursor)
            throw new Error('回合核实的分页游标未前进')
          // 只有交付结果仍未知的那一页需要消息正文，不能从回合终态猜测插话是否已被消费。
          if (page.data.some((turn) => uncertain.has(turn.id)))
            page = await host.request(
              'thread/turns/list',
              { threadId: live.id, cursor, limit: 100, sortDirection: 'desc', itemsView: 'full' },
              { timeoutMs: LOAD_TIMEOUT },
            )
          turns.push(...page.data)
          for (const turn of page.data) missing.delete(turn.id)
          cursor = page.nextCursor
        } while (cursor && missing.size)
        thread.turns = turns.reverse()
      }
      // 读期间有新的回合通知、换了连接或重新载入：旧快照不能覆盖新的活动状态。
      if (
        sessions.get(live.id) !== live ||
        live.view !== view ||
        live.recoveryRevision !== revision ||
        live.loading ||
        live.stale
      )
        return false
      const latest = thread.turns.at(-1)
      if (
        latest &&
        (latest.status === 'interrupted' || latest.status === 'failed') &&
        running.some((entry) => entry.serverId === latest.id)
      )
        pauseQueue(live)
      for (const entry of running) {
        const turn = thread.turns.find((candidate) => candidate.id === entry.serverId)
        if (!turn || turn.status === 'inProgress') continue
        for (const item of turn.items) reconcileInput(live, item)
        putTurn(live, turn)
        settleItems(live, turn.id, turn.status === 'completed')
        settleTodo(live, turn.id)
        settleSteered(live, entry.viewId, turn.status === 'completed')
        settleRequests(live, (request) => request.turnId === turn.id)
      }
      // 新回合的开始通知可能也没到；历史明确在跑的回合要补进视图，不能误开另一回合。
      for (const turn of thread.turns) {
        if (
          turn.status === 'inProgress' &&
          !view.turns.some((entry) => entry.id === viewTurn(live, turn.id))
        )
          putTurn(live, turn)
      }
      if (
        thread.status.type === 'active' ||
        thread.turns.some((turn) => turn.status === 'inProgress')
      ) {
        live.needsTurnCheck = false
        return false
      }
      if (isRunning(view)) return false
      live.needsTurnCheck = false
      remember(live)
      return true
    } catch (error) {
      host.log(`核实会话 ${live.id} 的回合状态失败：${failure(error).message}`)
      return false
    }
  }

  const isCompacting = (live: Live): boolean =>
    Boolean(
      live.compactSwitch ||
        live.compacting > 0 ||
        (live.view &&
          isRunning(live.view)?.itemIds.some(
            (id) =>
              live.view?.items[id]?.kind === 'compaction' &&
              live.view?.items[id]?.status === 'inProgress',
          )),
    )

  /** 同步或压缩期间记住的“现在发送”，恢复后使用真实回合号。每条只尝试一次。 */
  const insertImmediate = async (live: Live): Promise<void> => {
    if (
      !live.immediate.size ||
      live.stale ||
      live.loading ||
      live.paused ||
      live.needsTurnCheck ||
      !reachable(live)
    )
      return
    if (!live.view?.live || !isRunning(live.view)) return
    if (isCompacting(live)) return
    const starting = live.starting ? live.startingInput.get(live.starting) : undefined
    if (starting) {
      const revision = live.pauseRevision
      const turnId = await starting.ready
      if (!turnId) pauseQueue(live)
      if (!turnId || revision !== live.pauseRevision || live.paused) return
      if (live.loading || live.stale || !reachable(live) || !isRunning(live.view)) return
    }
    for (const id of [...live.immediate]) {
      if (!live.immediate.delete(id)) continue
      const message = live.queued.find((row) => row.id === id && !row.delivery)
      if (!message) continue
      if (!abilities(live.view.harness, live.id).steer) {
        setNote(live, phrase('session.inputNoSteer'))
        continue
      }
      try {
        if (
          live.view.note &&
          typeof live.view.note !== 'string' &&
          ['session.inputSyncing', 'session.inputNoSteer'].includes(live.view.note.key)
        )
          setNote(live, null)
        await sessionsApi.steer(live.id, id)
      } catch (error) {
        const reason = failure(error)
        setNote(live, reason.text ?? phrase('session.steerQueued', { message: reason.message }))
      }
      if (live.paused || live.loading || live.stale) return
    }
  }

  /** 空下来了就把排着队的第一条发出去 */
  const pump = (live: Live) => {
    // 摆着旧的、正在重新载入的：等载入完（load 成功时再 pump）
    if (
      live.stale ||
      live.loading ||
      isCompacting(live) ||
      live.paused ||
      live.needsTurnCheck ||
      live.dispatching.length
    )
      return
    if (!live.view?.live || !reachable(live)) return
    if (isRunning(live.view)) {
      void insertImmediate(live)
      return
    }
    const next = live.queued.find((entry) => !entry.delivery)
    if (!next) return
    live.immediate.delete(next.id)
    const clientId = `litch-${host.deviceId}-${runMark}-${++localSeq}`
    const dispatch = { ...next, clientId, delivery: 'unknown' as const }
    live.dispatching.push(dispatch)
    live.queued = live.queued.filter((entry) => entry !== next)
    // 新尝试号必须先可靠保存。否则重启只看到旧 held 副本，会把已经送出的内容再发一遍。
    if (!persistInputs(live)) {
      live.dispatching = live.dispatching.filter((entry) => entry !== dispatch)
      live.queued = [{ ...next, delivery: 'held' }, ...live.queued]
      live.paused = true
      live.pauseRevision++
      emit(live, [{ op: 'queue.set', queued: live.queued }])
      return
    }
    emit(live, [{ op: 'queue.set', queued: live.queued }])
    startTurn(live, next, clientId).then(
      () => {
        live.dispatching = live.dispatching.filter((entry) => entry !== dispatch)
        persistInputs(live)
        if (live.view?.note) setNote(live, null)
        pump(live)
      },
      (error: unknown) => {
        live.dispatching = live.dispatching.filter((entry) => entry !== dispatch)
        // 没发出去：放回队首，停下来等用户处理，不自己反复重试
        live.pauseRevision++
        live.paused = true
        const code = failure(error).code
        live.queued = [
          {
            ...next,
            clientId,
            delivery: code === 'timeout' || code === 'offline' ? 'unknown' : 'held',
          },
          ...live.queued,
        ]
        emit(live, [{ op: 'queue.set', queued: live.queued }])
        const reason = failure(error)
        setNote(live, reason.text ?? phrase('session.queueFailed', { message: reason.message }))
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
    live.recoveryRevision++
    if (
      method === 'item/started' ||
      method === 'item/completed' ||
      (method.startsWith('item/') && /delta$/i.test(method))
    ) {
      const id = viewTurn(live, (params as { turnId: string }).turnId)
      const turn = live.view.turns.find((turn) => turn.id === id)
      const clear: SessionOp[] = []
      if (turn?.retry?.message) clear.push({ op: 'turn.retry', turnId: id, retry: null })
      if (turn?.recovery) clear.push({ op: 'turn.recovery', turnId: id, recovery: null })
      if (clear.length) emit(live, clear)
    }
    if (replay && method.endsWith('elta')) {
      // 载入期间攒下的文本增量：条目已经在快照里的不再加，免得同一段文字出现两遍。
      // 就算因此少了几个字，条目定稿时对面会给出完整内容。
      const { turnId, itemId } = params as { turnId: string; itemId: string }
      if (live.view.items[viewItem(live, viewTurn(live, turnId), itemId)]) return
    }
    handler(live, params as never)
  }

  const blank = (id: string): Live => ({
    historyCursor: null,
    paging: null,
    pageJob: null,
    recoveryRevision: 0,
    managerRevision: 0,
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
    queued: host.pendingInputs?.load(id) ?? [],
    withdrawn: new Set(host.pendingInputs?.withdrawn(id) ?? []),
    paused: false,
    pauseRevision: 0,
    needsTurnCheck: false,
    dispatching: [],
    startingInput: new Map(),
    pending: {},
    steered: new Map(),
    immediate: new Set(),
    reverting: false,
    revertEchoed: false,
    revertEchoUntil: 0,
    compacting: 0,
    stale: false,
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
    if (!abilities(harness, live.id)[ability]) throw new ChannelError('unsupported', UNSUPPORTED)
    try {
      return await run()
    } catch (error) {
      if (!lacksMethod(error)) throw failure(error)
      // 聚合面替它说“不支持”的时候写着是哪个 harness：照它说的记
      markLacking(deviceFault(error)?.harness ?? harness, ability, live.id)
      throw new ChannelError('unsupported', UNSUPPORTED)
    }
  }

  /** 持续目标的请求：和 attempt 一样，另外对面关着这个特性（goals feature is disabled）也记成不会 */
  const attemptGoal = async <T,>(
    live: Live & { view: SessionView },
    run: () => Promise<T>,
  ): Promise<T> => {
    const { harness } = live.view
    if (!abilities(harness, live.id).goals) throw new ChannelError('unsupported', UNSUPPORTED)
    try {
      return await run()
    } catch (error) {
      if (!lacksMethod(error) && !goalsOff(error)) throw failure(error)
      markLacking(deviceFault(error)?.harness ?? harness, 'goals', live.id)
      throw new ChannelError('unsupported', UNSUPPORTED)
    }
  }

  /** 这些事都要够得着对面、没有回合在进行。why 是回合在进行时对人说的那句 */
  const idle = (sessionId: string, why: string): Live & { view: SessionView } => {
    const live = need(sessionId)
    mustReach(live)
    if (isRunning(live.view) || live.compactSwitch) throw new ChannelError('rejected', why)
    return live
  }

  const need = (sessionId: string): Live & { view: SessionView } => {
    const live = sessions.get(sessionId)
    if (!live?.view) throw new ChannelError('notFound', `会话未打开：${sessionId}`)
    return live as Live & { view: SessionView }
  }

  const sessionsApi: LiveSessions = {
    managerStatus(sessionId, status) {
      managerStates.set(sessionId, status)
      const live = sessions.get(sessionId)
      if (live) live.managerRevision++
      const note = managerNote(sessionId)
      if (live && note) emit(live, [{ op: 'session.state', live: false, note }])
      else if (
        live?.view &&
        !live.view.live &&
        !live.loading &&
        host.online() &&
        !host.shelved(sessionId)
      )
        void load(live)
    },
    loadOlder(sessionId) {
      const live = need(sessionId)
      if (live.pageJob) return live.pageJob
      if (live.loading || live.stale || live.reverting || !live.view.history?.hasMore)
        return Promise.resolve()
      mustReach(live)
      const cursor = live.historyCursor
      const cancel = createCancel()
      live.paging = cancel
      emit(live, [
        { op: 'session.history', history: { hasMore: true, loading: true, error: null } },
      ])
      const current = () =>
        !cancel.signal.aborted && sessions.get(live.id) === live && live.paging === cancel
      const job = (async () => {
        try {
          const page = await host.request(
            'thread/turns/list',
            {
              threadId: live.id,
              cursor,
              limit: HISTORY_PAGE_SIZE,
              sortDirection: 'desc',
              itemsView: 'full',
            },
            { timeoutMs: LOAD_TIMEOUT, signal: cancel.signal },
          )
          if (!current()) return
          if (page.nextCursor !== null && page.nextCursor === cursor)
            throw new Error('历史分页游标未前进')
          const older = [...page.data]
            .reverse()
            .map((turn) => projectTurn(turn, turn.id, ownerOf(live) === 'codex'))
          live.historyCursor = page.nextCursor
          emit(live, [
            {
              op: 'history.prepend',
              turns: older.map((entry) => entry.turn),
              items: older.flatMap((entry) => entry.items),
            },
            {
              op: 'session.history',
              history: { hasMore: page.nextCursor !== null, loading: false, error: null },
            },
          ])
        } catch (error) {
          if (!current()) return
          if (error instanceof RpcError && error.code === -32602) {
            // 别的客户端回退了历史，旧游标已失效：重新建立页边界，不拼接两版历史。
            await load(live)
            return
          }
          const reason = failure(error)
          emit(live, [
            {
              op: 'session.history',
              history: { hasMore: true, loading: false, error: reason.message },
            },
          ])
          throw reason
        } finally {
          if (live.paging === cancel) {
            live.paging = null
            live.pageJob = null
          }
        }
      })()
      live.pageJob = job
      return job
    },
    async recover(sessionId, turnId, text) {
      const live = need(sessionId)
      mustReach(live)
      const turn = live.view.turns.find((turn) => turn.id === turnId)
      if (!host.recoverySupported?.() || !turn?.recovery || turn.status !== 'running')
        throw new ChannelError('rejected', 'The turn is no longer waiting for recovery')
      if (text && (live.queued.length || live.view.requests.length))
        throw new ChannelError(
          'rejected',
          'Resolve pending requests and queued messages before continuing',
        )
      const rawTurnId = [...live.alias].find(([, id]) => id === turnId)?.[0] ?? turnId
      const harness = live.view.harness
      if (!harness) throw new ChannelError('unsupported', 'Recovery requires an executing device')
      const params = { harness, threadId: sessionId, turnId: rawTurnId }
      if (text) {
        host.interrupting?.(sessionId)
        await host.request(
          'litch/device/recovery/continue',
          { ...params, text },
          { timeoutMs: 40000 },
        )
      } else await host.request('litch/device/recovery/dismiss', params)
    },
    open(sessionId, sink) {
      let live = sessions.get(sessionId)
      if (!live) {
        live = blank(sessionId)
        sessions.set(sessionId, live)
      }
      const entry = live
      unlinger(entry.id)
      entry.sinks.add(sink)
      if (entry.view && !entry.stale) sink.snapshot(entry.view)
      else {
        // 手里没有、或者是旧的：先摆旧的（核心留着的，或者这台电脑上存的），最新的到了整份换掉。
        // 存的那份也放进核心：这期间发的话先排着（send），载入完再发
        const cached = entry.view ?? recall(entry.id)
        const old =
          cached && host.pendingInputs ? restorePendingView(cached, host.pendingInputs) : cached
        if (old) {
          entry.view = old
          entry.stale = true
          sink.snapshot({ ...staleView(old), queued: entry.queued })
        }
        // 设备还没连上就先等着，连上时会统一载入；它所属的 harness 现在不可用也一样，恢复时再载入
        if (!entry.loading && reachable(entry)) load(entry)
      }
      return () => {
        entry.sinks.delete(sink)
        if (entry.sinks.size === 0 && !entry.view) {
          entry.loading?.abort()
          entry.loading = null
          settleRequests(entry, () => true)
          sessions.delete(entry.id)
          return
        }
        release(entry)
      }
    },

    watched: (sessionId) => (sessions.get(sessionId)?.sinks.size ?? 0) > 0,

    view: (sessionId) => sessions.get(sessionId)?.view ?? null,

    resync() {
      lacking.clear()
      for (const live of [...sessions.values()]) {
        // 没人看、还留着的：订阅随连接没了，视图留着当旧的，再打开时先摆它、同时重新载入
        if (live.sinks.size === 0 && live.queued.length === 0) {
          if (lingering.has(live.id)) live.stale = true
          else sessions.delete(live.id)
        }
        // 所属的 harness 这时不可用的先不载入，留着上次的内容，等它恢复（harnessUp）
        else if (reachable(live)) load(live)
      }
    },

    offline() {
      for (const live of sessions.values()) {
        cancelPage(live)
        live.compactSwitch?.reject(
          new ChannelError('offline', '连接已断开，未切换供应商', phrase('session.switchOffline')),
        )
        live.loading?.abort()
        live.loading = null
        live.starting = null
        settleRequests(live, () => true)
      }
    },

    harnessUp(harness) {
      lacking.delete(harness)
      for (const key of lacking.keys()) if (key.startsWith(`${harness}:`)) lacking.delete(key)
      for (const live of [...sessions.values()]) {
        if (ownerOf(live) !== harness) continue
        if (live.sinks.size === 0 && live.queued.length === 0) {
          if (lingering.has(live.id)) live.stale = true
          else sessions.delete(live.id)
        } else load(live)
      }
    },

    harnessDown(harness) {
      for (const live of sessions.values()) {
        if (ownerOf(live) !== harness) continue
        cancelPage(live)
        live.compactSwitch?.reject(
          new ChannelError('offline', '引擎已断开，未切换供应商', phrase('session.switchOffline')),
        )
        live.loading?.abort()
        live.loading = null
        live.starting = null
        settleRequests(live, () => true)
      }
    },

    forget(sessionId, erased = false) {
      if (erased) todos.delete(sessionId)
      if (erased) host.pendingInputs?.save(sessionId, [], [])
      unlinger(sessionId)
      host.views?.forget(sessionId)
      const live = sessions.get(sessionId)
      if (!live) return
      cancelPage(live)
      live.compactSwitch?.reject(
        new ChannelError(
          'cancelled',
          '会话已关闭，未切换供应商',
          phrase('session.switchCancelled'),
        ),
      )
      live.loading?.abort()
      live.loading = null
      live.queued = []
      settleRequests(live, () => true)
      sessions.delete(sessionId)
    },

    restored(sessionId) {
      const live = sessions.get(sessionId)
      if (!live) return
      if (live.sinks.size === 0) {
        live.loading?.abort()
        live.loading = null
        unlinger(sessionId)
        sessions.delete(sessionId)
        return
      }
      // 恢复的应答和对面的 thread/unarchived 都会叫到这里：已经在载入、已经是能发消息的那一份就不再载入一遍，
      // 免得刚换上的对话区又整份重来（期间发的话也被这一遍盖住）
      if (live.loading || live.view?.live) return
      if (reachable(live)) load(live)
    },

    setAgents(sessionId, agents) {
      const live = sessions.get(sessionId)
      if (!live?.view) return
      // 列表常常整份重来一遍（对账、问列表），没变的不发
      if (JSON.stringify(live.view.agents) === JSON.stringify(agents)) return
      emit(live, [{ op: 'session.agents', agents }])
    },

    settleProposal(sessionId, proposalId, status, startedId) {
      const live = sessions.get(sessionId)
      if (!live?.view?.proposals.some((proposal) => proposal.id === proposalId)) return
      const settledAt = status === 'chosen' ? null : host.clock.now()
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
      // 子代理的请求可能显示在父会话里。请求号在连接内唯一，按号撤回，不取决于当前打开了哪页。
      if (method === 'serverRequest/resolved') {
        for (const live of sessions.values()) deliver(live, method, params)
        return true
      }
      const threadId = (params as { threadId?: unknown } | null)?.threadId
      const live = typeof threadId === 'string' ? sessions.get(threadId) : undefined
      if (live) deliver(live, method, params)
      return true
    },

    serverRequest(method, params, id) {
      const threadId = (params as { threadId?: unknown } | null)?.threadId
      let live = typeof threadId === 'string' ? sessions.get(threadId) : undefined
      let ancestor = typeof threadId === 'string' ? threadId : null
      const visited = new Set<string>()
      while (!live?.view && !live?.loading && ancestor && !visited.has(ancestor)) {
        visited.add(ancestor)
        ancestor = host.agentParent?.(ancestor) ?? null
        live = ancestor ? sessions.get(ancestor) : undefined
      }
      // 普通打开、重连、父界面订阅都可能先收到 resume 重放的请求，再收到历史。
      // 载入中的会话先登记，快照就绪后一起呈现，不能回“方法不存在”让真实请求失败。
      if (!live || (!live.view && !live.loading)) return undefined
      const projected = projectRequest(
        method,
        params,
        String(id),
        requestTerms(ownerOf(live) ?? '', typeof threadId === 'string' ? threadId : live.id),
      )
      // 跨页卡片不挂父回合条目，也不随父回合完成误收掉。
      const pending =
        projected && live.id !== threadId ? { ...projected, turnId: null, itemId: null } : projected
      if (!pending) return undefined
      const viewId = pending.turnId ? viewTurn(live, pending.turnId) : null
      const key = viewId && pending.itemId ? viewItem(live, viewId, pending.itemId) : null
      const view = { ...pending.view, itemId: key && live.view?.items[key] ? key : null }
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

    toolsFor: (harness) => host.dynamicTools?.(harness) ?? [],

    async create(cwd, message, settings, harness, workspaceId, asGoal = false, worktree) {
      if (!host.online()) throw new ChannelError('offline', '设备未连接')
      let started: Awaited<ReturnType<typeof host.request<'thread/start'>>>
      // 还没有会话对象：它算在谁头上，聚合面上就是指定的那个，单个入口上只有那一个
      const target = harness ?? host.sole()
      const objective = message.text.trim()
      if (asGoal) {
        // 不会持续目标的不去建会话：建出来也设不了目标，只会留一个空会话
        if (target === null || !abilities(target).goals)
          throw new ChannelError('unsupported', UNSUPPORTED)
        if (!objective) throw new ChannelError('rejected', '目标不能为空')
      }
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
        started = await withSpeed(
          'thread/start',
          {
            cwd,
            ...atStart,
            // 聚合面上这是“针对某个 harness”的请求，要指明建在哪个上；别的对面不认识这个参数，不带
            ...(harness === null ? {} : { harness }),
            // 归到哪个工作区。这是协议里原有的参数；对面没有工作区这回事时调用方给的是 null
            ...(workspaceId === null ? {} : { projectId: workspaceId }),
            ...(tools && tools.length > 0 ? { dynamicTools: tools as never } : {}),
            // 工作树的短名用第一句话起（设备转成小写短横线串，转不出就只用随机串）
            ...(worktree
              ? {
                  litchWorktree: {
                    ...(worktree.from ? { from: worktree.from } : {}),
                    title: objective.split('\n')[0]?.slice(0, 80) ?? '',
                  },
                }
              : {}),
          },
          // 先建工作树的要多等：大仓库检出、复制被忽略的文件可能要几十秒
          { timeoutMs: worktree ? WORKTREE_TIMEOUT : LOAD_TIMEOUT },
        )
      } catch (error) {
        throw failure(error)
      }
      const { thread } = started
      const live = blank(thread.id)
      const owner = host.harnessFor(thread)
      host.rememberCapabilities?.(thread)
      const actual = projectSettings(started, presetsOf(owner, thread.id))
      live.pending = settingsDiff(settings, actual)
      live.view = {
        ...projectThread(thread, { deviceId: host.deviceId, harness: owner }),
        settings: { ...actual, ...live.pending },
        can: abilities(owner, thread.id),
      }
      sessions.set(live.id, live)
      host.started(thread)
      try {
        if (asGoal) {
          await attemptGoal(live as Live & { view: SessionView }, () =>
            host.request(
              'thread/goal/set',
              { threadId: live.id, origin: 'user', objective },
              { timeoutMs: LOAD_TIMEOUT },
            ),
          )
          host.touched(live.id)
        } else await startTurn(live, message)
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
      if (live.compactSwitch)
        throw new ChannelError('rejected', '正在压缩并切换供应商', phrase('session.switchBusy'))
      for (const key of ['model', 'effort', 'speed', 'permission'] as const) {
        const value = settings[key]
        if (value) live.pending[key] = value
      }
      if (settings.mode) live.pending.mode = settings.mode
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, ...live.pending } }])
    },

    async implementPlan(sessionId, text) {
      const live = need(sessionId)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      mustReach(live)
      if (isRunning(live.view) || live.queued.length > 0) {
        throw new ChannelError('rejected', '回合正在进行，暂时无法执行计划')
      }
      // 退出计划模式和“执行”是同一个回合里的事：模式跟着这个回合发过去。
      // 标识以 plan: 开头是和适配器的约定：Pi 引擎认出来之后走它自己的“实施计划”，不把这句话当成新的要求
      live.pending.mode = 'default'
      emit(live, [{ op: 'session.settings', settings: { ...live.view.settings, ...live.pending } }])
      await startTurn(live, outgoing(text), `plan:${host.clock.now()}-${++localSeq}`)
    },

    async send(sessionId, message, now, pending = 'include') {
      const live = need(sessionId)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      mustReach(live)
      const beforeInput = host.beforeInput?.(sessionId)
      if (beforeInput) await beforeInput
      const pauseRevision = live.pauseRevision
      if (
        live.needsTurnCheck &&
        (!(await reconcileTurns(live)) || live.pauseRevision !== pauseRevision)
      ) {
        live.queued.push({ id: `q${++localSeq}`, ...message, delivery: 'held' })
        pauseQueue(live)
        setNote(live, phrase('session.steerHeld'))
        return
      }
      const insert =
        now && (live.stale || live.loading !== null || isCompacting(live) || !!isRunning(live.view))
      const held = live.queued.some((entry) => entry.delivery === 'held')
      if (held || live.paused) {
        live.paused = false
        if (pending === 'include')
          live.queued = live.queued.map((entry) => {
            if (entry.delivery !== 'held') return entry
            if (insert) live.immediate.add(entry.id)
            return releaseInput(entry)
          })
      }
      if (
        held ||
        live.stale ||
        live.loading ||
        isCompacting(live) ||
        isRunning(live.view) ||
        live.queued.length > 0
      ) {
        const id = `q${++localSeq}`
        live.queued = [...live.queued, { id, ...message }]
        if (insert) live.immediate.add(id)
        emit(live, [{ op: 'queue.set', queued: live.queued }])
        if (now && (live.stale || live.loading)) setNote(live, phrase('session.inputSyncing'))
        await insertImmediate(live)
        pump(live)
        return
      }
      await startTurn(live, message)
      if (live.view.note) setNote(live, null)
    },

    hold(sessionId, message, error) {
      const live = need(sessionId)
      live.queued = [...live.queued, { id: `q${++localSeq}`, ...message }]
      emit(live, [{ op: 'queue.set', queued: live.queued }])
      setNote(live, phrase('session.queueFailed', { message: failure(error).message }))
    },

    async resumeQueue(sessionId, messageId) {
      const live = need(sessionId)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      mustReach(live)
      const pauseRevision = live.pauseRevision
      if (live.needsTurnCheck) await reconcileTurns(live)
      if (live.needsTurnCheck || live.pauseRevision !== pauseRevision) {
        setNote(live, phrase('session.steerHeld'))
        throw new ChannelError('rejected', '状态尚未核实，消息仍待发', phrase('session.steerHeld'))
      }
      const insert = !!isRunning(live.view) || live.loading !== null || live.stale
      live.queued = live.queued.map((entry) => {
        if (entry.delivery !== 'unknown' && (!messageId || messageId === entry.id)) {
          if (insert) live.immediate.add(entry.id)
          return entry.delivery === 'held' ? releaseInput(entry) : entry
        }
        return entry
      })
      live.paused = false
      emit(live, [{ op: 'queue.set', queued: live.queued }])
      if (live.stale || live.loading) setNote(live, phrase('session.inputSyncing'))
      await insertImmediate(live)
      pump(live)
    },

    async steer(sessionId, messageId) {
      const live = need(sessionId)
      const message = live.queued.find((entry) => entry.id === messageId)
      if (!message) throw new ChannelError('rejected', '该消息已不在队列中')
      if (message.delivery)
        throw new ChannelError('rejected', '该消息已暂停，请使用待发消息的发送或编辑操作')
      mustReach(live)
      if (live.stale || live.loading) {
        live.immediate.add(messageId)
        setNote(live, phrase('session.inputSyncing'))
        return
      }
      if (isCompacting(live)) {
        live.immediate.add(messageId)
        return
      }
      const starting = live.starting ? live.startingInput.get(live.starting) : undefined
      if (starting) {
        const revision = live.pauseRevision
        setNote(live, phrase('session.inputSyncing'))
        if (!(await starting.ready) || revision !== live.pauseRevision || live.paused)
          throw new ChannelError(
            'rejected',
            '回合启动已取消，消息仍待发',
            phrase('session.steerHeld'),
          )
        if (!live.queued.some((row) => row.id === messageId)) return
        mustReach(live)
        if (live.stale || live.loading) {
          live.immediate.add(messageId)
          return
        }
      }
      const running = isRunning(live.view)
      const turnId = running ? serverTurn(live, running.id) : null
      if (!running || !turnId) throw new ChannelError('rejected', '当前没有可插入消息的回合')
      const { harness } = live.view
      const can = abilities(harness, live.id)
      // 声明了不会的、试过不行的：不去发，消息照常排着等这个回合结束
      if (!can.steer) throw new ChannelError('unsupported', UNSUPPORTED)
      if (!can.steerImages && message.images.length > 0) {
        throw new ChannelError(
          'rejected',
          '带图片的消息不能中途插进去',
          phrase('fault.steerImages'),
        )
      }
      const clientId = `litch-${host.deviceId}-${runMark}-${++localSeq}`
      const key = `${running.id}:steer:${localSeq}`
      // 先从队列里拿出来、显示进回合里，不等对面
      live.queued = live.queued.filter((entry) => entry !== message)
      const { id: _queueId, ...said } = message
      const mentions = mentionsIn(live)
      const tracked =
        host.terms(harness, live.id)?.extensions.includes(EXTENSION.inputDelivery) === true
      live.steered.set(clientId, { key, turnId: running.id, message: said, tracked })
      emit(live, [
        { op: 'queue.set', queued: live.queued },
        {
          op: 'item.add',
          turnId: running.id,
          item: {
            ...localUserMessage(key, said, mentions),
            unconfirmed: true,
            ...(tracked ? { delivery: 'queued' as const } : {}),
          },
        },
      ])
      try {
        await host.request('turn/steer', {
          threadId: sessionId,
          expectedTurnId: turnId,
          clientUserMessageId: clientId,
          input: toInput(said, mentions),
        })
      } catch (error) {
        // 没插成：原样退回队首；明确没有活动回合时先核实，不能无限等一个不会到来的结束通知。
        // 停止收尾或回显已经接管此输入，迟到的失败不能再恢复第二份。
        if (!live.steered.has(clientId)) return
        const staleTurn =
          error instanceof RpcError &&
          (error.message === 'no active turn to steer' ||
            (error.code === -32009 &&
              ['指定回合与当前活动回合不一致', '指定回合与活动回合不一致'].includes(error.message)))
        if (staleTurn) live.needsTurnCheck = true
        live.steered.delete(clientId)
        live.queued = [live.paused ? { ...message, delivery: 'held' } : message, ...live.queued]
        emit(live, [
          { op: 'item.remove', turnId: running.id, itemId: key },
          { op: 'queue.set', queued: live.queued },
        ])
        // 请求发出后服务端才进入压缩：明确拒绝并未受理，留给压缩结束事件恢复。
        if (
          error instanceof RpcError &&
          error.code === -32009 &&
          error.message === '正在压缩上下文，请等待压缩结束后发送'
        ) {
          if (!live.paused) live.immediate.add(messageId)
          return
        }
        if (staleTurn) {
          const idle = await reconcileTurns(live)
          // 用户可能在对账期间移除消息；不要把它恢复回来，也不要覆盖其他消息的结果。
          if (!live.queued.some((entry) => entry.id === message.id)) return
          if (idle && !live.paused) {
            setNote(live, null)
            pump(live)
          } else {
            pauseQueue(live)
            setNote(live, phrase('session.steerHeld'))
          }
          return
        }
        pump(live)
        if (!lacksMethod(error)) throw failure(error)
        // 对面不会引导：记下来，这个 harness 上的入口都停掉
        markLacking(deviceFault(error)?.harness ?? harness, 'steer', live.id)
        throw new ChannelError('unsupported', UNSUPPORTED)
      }
    },

    async interrupt(sessionId) {
      const opened = sessions.get(sessionId)
      // 没打开过的会话（后台任务页上停一个子会话、子代理）：不为停它去打开订阅，问对面最近一个回合，在跑就打断它
      if (!opened?.view) {
        let last: { id: string; status: string } | undefined
        try {
          const page = await host.request('thread/turns/list', {
            threadId: sessionId,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded',
          })
          last = page.data[0]
        } catch (error) {
          throw failure(error)
        }
        if (last?.status !== 'inProgress')
          throw new ChannelError('rejected', '当前没有可中断的回合')
        try {
          await host.request('turn/interrupt', { threadId: sessionId, turnId: last.id })
        } catch (error) {
          throw failure(error)
        }
        return
      }
      const live = need(sessionId)
      const running = isRunning(live.view)
      let turnId = running ? serverTurn(live, running.id) : null
      const starting = running ? live.startingInput.get(running.id) : undefined
      if (!turnId && !starting) throw new ChannelError('rejected', '当前没有可中断的回合')
      pauseQueue(live)
      host.interrupting?.(sessionId)
      if (!turnId && starting) {
        turnId = await starting.ready
        // 开始失败或回合已收尾，无须向其他回合补发停止。
        if (
          !turnId ||
          !live.view.turns.some((entry) => entry.id === running?.id && entry.status === 'running')
        )
          return
      }
      if (!turnId) return
      // 目标在做的时候按停止：先把目标暂停（照官方桌面端和终端界面），不然这一轮停下、空闲了它又接着续跑。
      // 暂停只等一小会儿，没成也照样打断：停下回合要紧
      if (live.view.goal?.status === 'active' && abilities(live.view.harness, live.id).goals) {
        await host
          .request(
            'thread/goal/set',
            { threadId: sessionId, origin: 'user', status: 'paused' },
            { timeoutMs: PAUSE_BEFORE_STOP_MS },
          )
          .catch((error: unknown) => host.log(`停止前暂停目标没成：${String(error)}`))
      }
      try {
        await host.request('turn/interrupt', { threadId: sessionId, turnId })
      } catch (error) {
        throw failure(error)
      }
    },

    async stopBackground(sessionId, taskId, itemId) {
      need(sessionId)
      let processId: string | null = null
      try {
        const listed = await host.request('thread/backgroundTerminals/list', {
          threadId: sessionId,
        })
        const found = listed.data.find(
          (terminal) => terminal.processId === taskId || (itemId && terminal.itemId === itemId),
        )
        processId = found?.processId ?? null
      } catch (error) {
        throw failure(error)
      }
      if (processId === null)
        throw new ChannelError('rejected', '找不到这个后台任务', phrase('fault.backgroundStop'))
      try {
        const { terminated } = await host.request('thread/backgroundTerminals/terminate', {
          threadId: sessionId,
          processId,
        })
        if (!terminated)
          throw new ChannelError('rejected', '没能停掉这个后台任务', phrase('fault.backgroundStop'))
      } catch (error) {
        throw error instanceof ChannelError ? error : failure(error)
      }
    },

    unqueue(sessionId, messageId) {
      const live = need(sessionId)
      const next = live.queued.filter((message) => message.id !== messageId)
      if (next.length === live.queued.length) return
      live.immediate.delete(messageId)
      live.queued = next
      emit(live, [{ op: 'queue.set', queued: next }])
      release(live)
    },

    respond(sessionId, requestId, choice) {
      const live = need(sessionId)
      const request = live.requests.get(requestId)
      if (!request) throw new ChannelError('rejected', '该请求已不存在')
      if (choice.note?.trim()) {
        // 说明只能跟着声明了能带说明的选项走，别的不替用户悄悄丢掉
        const { view } = request
        const option =
          view.kind === 'approval' || view.kind === 'clientAsk'
            ? view.options.find((entry) => entry.id === choice.optionId)
            : undefined
        if (!option?.note) throw new ChannelError('rejected', '该选项不支持附加说明')
      }
      const result = request.answer(choice)
      if (result === null) throw new ChannelError('rejected', '该请求没有此选项')
      live.requests.delete(requestId)
      request.resolve(result)
      emit(live, [
        { op: 'request.remove', requestId },
        ...clockCommand(live, request.view, host.clock.now()),
      ])
    },

    async fork(sessionId, turnId, itemId) {
      const live = idle(sessionId, '回合正在进行，结束后才能分叉')
      const last = live.view.turns.some((turn) => turn.id === turnId)
        ? serverTurn(live, turnId)
        : null
      if (!last) throw new ChannelError('rejected', '该回合已不存在')
      const cut = itemId === undefined ? null : cutAt(live, turnId, itemId)
      const { thread } = await attempt(live, 'fork', () =>
        withSpeed(
          'thread/fork',
          // 新会话的内容打开时再取，这里不要
          {
            threadId: sessionId,
            ...(cut ? { beforeTurnId: last, beforeItemId: cut } : { lastTurnId: last }),
            excludeTurns: true,
          },
          { timeoutMs: LOAD_TIMEOUT },
        ),
      )
      host.started(thread)
      return thread.id
    },

    async sideChat(sessionId) {
      const live = need(sessionId)
      mustReach(live)
      if (!live.view.can.sideChat) throw new ChannelError('unsupported', UNSUPPORTED)
      const { turns } = live.view
      const running = isRunning(live.view)
      // 有回合在跑：截在它之前，带走的都是结束了的回合（几家都只许这样在跑的时候分）；
      // 它还没拿到对面的回合标识（刚发出去）就等一会儿再来。没在跑：带到最后一个回合为止
      let where: { beforeTurnId: string } | { lastTurnId: string } | null = null
      if (running) {
        const server = serverTurn(live, running.id)
        if (!server) throw new ChannelError('rejected', '回合正在开始，稍后再试')
        where = { beforeTurnId: server }
      } else {
        const last = turns.at(-1)
        const server = last ? serverTurn(live, last.id) : null
        if (last && !server) throw new ChannelError('rejected', '回合正在开始，稍后再试')
        if (server) where = { lastTurnId: server }
      }
      const { thread } = await attempt(live, 'fork', () =>
        withSpeed(
          'thread/fork',
          // 内容打开时再取。临时的：不落盘、不进线程列表，侧栏也不放（device.mts 的 transient）
          { threadId: sessionId, ...where, ephemeral: true, excludeTurns: true },
          { timeoutMs: LOAD_TIMEOUT },
        ),
      )
      host.started(thread)
      noted.add(thread.id)
      return thread.id
    },

    async rollback(sessionId, turnId, itemId) {
      const live = idle(sessionId, '回合正在进行，结束后才能回退')
      cancelPage(live)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      const before = live.view.turns.some((turn) => turn.id === turnId)
        ? serverTurn(live, turnId)
        : null
      if (!before) throw new ChannelError('rejected', '该回合已不存在')
      const cut = itemId === undefined ? null : cutAt(live, turnId, itemId)
      const original = live.view
      const originalLast = original.turns.at(-1)?.id
      let cursor: string | null = null
      live.reverting = true
      live.revertEchoed = false
      try {
        // 按回合的标识回退，不按“倒数几个”：两边数出来的个数万一不一样，撤错了找不回来
        const reverted = await attempt(live, 'rollback', () =>
          host.request(
            'thread/revert',
            { threadId: sessionId, beforeTurnId: before, ...(cut ? { beforeItemId: cut } : {}) },
            { timeoutMs: LOAD_TIMEOUT },
          ),
        )
        cursor = reverted.turnsBackwardsCursor
      } finally {
        live.reverting = false
      }
      // 对面的“历史被改写了”还没到：等会儿到的那一条说的是这一次
      if (!live.revertEchoed) live.revertEchoUntil = host.clock.now() + REVERT_ECHO_MS
      // 插话只重取被截断的一个回合；避免恢复整条会话、重读较早正文后才发编辑后的消息。
      let retained: ReturnType<typeof projectTurn> | null = null
      if (cut) {
        try {
          const page = await host.request(
            'thread/turns/list',
            {
              threadId: sessionId,
              cursor,
              limit: 1,
              sortDirection: 'desc',
              itemsView: 'full',
            },
            { timeoutMs: LOAD_TIMEOUT },
          )
          const last = page.data[0]
          if (
            !last ||
            last.id !== before ||
            last.itemsView !== 'full' ||
            sessions.get(live.id) !== live ||
            live.view !== original ||
            live.view.turns.at(-1)?.id !== originalLast ||
            live.loading ||
            live.stale ||
            isRunning(live.view)
          )
            throw new Error('回退期间会话发生变化，需要重新同步')
          retained = projectTurn(last, turnId, ownerOf(live) === 'codex')
        } catch (error) {
          host.log(`读取回退后的回合失败：${String(error)}`)
          if (sessions.get(live.id) === live) await load(live)
          host.touched(live.id)
          return
        }
      }
      // 删除了当前页的全部回合时，需要补入更早一页；已有保留回合时继续使用原分页游标。
      if (
        !cut &&
        (live.view !== original ||
          live.view.turns.at(-1)?.id !== originalLast ||
          (live.view.history?.hasMore && live.view.turns[0]?.id === turnId))
      ) {
        if (sessions.get(live.id) === live) await load(live)
        host.touched(live.id)
        return
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
      emit(live, [
        ...gone.map((viewId): SessionOp => ({ op: 'turn.remove', turnId: viewId })),
        ...(retained
          ? [
              { op: 'turn.add', turn: retained.turn } as SessionOp,
              ...retained.items.map((item): SessionOp => ({ op: 'item.add', turnId, item })),
            ]
          : []),
        ...(live.view.goalReached && gone.includes(live.view.goalReached.turnId)
          ? [{ op: 'session.goalReached', reached: null } as SessionOp]
          : []),
      ])
      if (retained && before !== turnId) live.alias.set(before, turnId)
      host.touched(live.id)
    },

    async compact(sessionId, thenConfigure) {
      const live = idle(sessionId, '回合正在进行，结束后才能压缩')
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      if (live.compacting)
        throw new ChannelError('rejected', '正在等待压缩开始', phrase('session.switchBusy'))
      let cancelTimer: (() => void) | undefined
      const completion = thenConfigure
        ? new Promise<void>((resolve, reject) => {
            live.compactSwitch = { turnId: null, completed: false, resolve, reject }
            cancelTimer = host.clock.setTimer(
              () =>
                reject(
                  new ChannelError(
                    'rejected',
                    '等待压缩完成超时，未切换供应商',
                    phrase('session.switchTimeout'),
                  ),
                ),
              10 * 60_000,
            )
          })
        : Promise.resolve()
      live.compacting++
      try {
        await Promise.all([
          completion,
          attempt(live, 'compact', () =>
            host.request(
              'thread/compact/start',
              { threadId: sessionId },
              { timeoutMs: LOAD_TIMEOUT },
            ),
          ),
        ])
        if (thenConfigure) {
          delete live.compactSwitch
          sessionsApi.configure(sessionId, thenConfigure)
        }
      } catch (error) {
        live.compacting = Math.max(0, live.compacting - 1)
        throw error
      } finally {
        cancelTimer?.()
        delete live.compactSwitch
        // 请求被拒绝时可能还没收到任何压缩事件，也要释放这段等待期间的普通待发消息。
        pump(live)
        if (thenConfigure) release(live)
      }
      host.touched(live.id)
    },
    async setGoal(sessionId, change) {
      const live = need(sessionId)
      mustReach(live)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      const objective = change.objective?.trim()
      if (change.objective !== undefined && !objective)
        throw new ChannelError('rejected', '目标不能为空')
      if (!live.view.goal && !objective)
        throw new ChannelError('rejected', '尚未设置目标，请先填写目标')
      await attemptGoal(live, () =>
        host.request(
          'thread/goal/set',
          {
            threadId: sessionId,
            origin: 'user',
            ...(objective ? { objective } : {}),
            ...(change.status ? { status: change.status } : {}),
            ...(change.tokenBudget !== undefined ? { tokenBudget: change.tokenBudget } : {}),
          },
          { timeoutMs: LOAD_TIMEOUT },
        ),
      )
      host.touched(live.id)
    },
    async clearGoal(sessionId) {
      const live = need(sessionId)
      mustReach(live)
      if (!live.view.live) throw new ChannelError('rejected', '此会话只读')
      await attemptGoal(live, () =>
        host.request(
          'thread/goal/clear',
          { threadId: sessionId, origin: 'user' },
          { timeoutMs: LOAD_TIMEOUT },
        ),
      )
      // 对面清掉了没有目标可清的会话时不发通知：这边自己收掉
      if (live.view.goal) emit(live, [{ op: 'session.goal', goal: null }])
    },
  }
  return sessionsApi
}
