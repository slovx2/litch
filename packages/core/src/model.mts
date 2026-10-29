import type {
  SessionDelegatedResponse,
  SessionPendingRequest,
} from '../../protocol/src/session-pending.mjs'

export type {
  SessionDelegatedResponse,
  SessionPendingRequest,
} from '../../protocol/src/session-pending.mjs'

// 界面看到的数据形状。界面不认识协议类型，只认识这里的类型，各种 harness 的差异在核心里消化掉。
// 协议条目怎么变成这些显示条目，见 projection 目录。
// 类型是 Text 的字段可能是对面给的原文，也可能是核心自己要说的一句话（见 phrase.mts），界面按当前语言显示。

import type { ApiRetryReason } from '../../protocol/src/api-retry.mjs'
import type { SessionMentionRef } from '../../protocol/src/session-mentions.mjs'
import type { SystemMessage } from '../../protocol/src/system-messages.mjs'
import type { SessionBackgroundView, TurnOrigin } from './model-background.mjs'
import type { GoalReachedView, SessionGoalView } from './model-goal.mjs'
import type { MachineAccessView, MachineAskView } from './model-machine.mjs'
import type {
  DeviceServiceView,
  RemoteUpgradeView,
  ServiceRestartView,
  ServiceUpgradeView,
} from './model-service.mjs'
import type { SessionTaskMark } from './model-tasks.mjs'
import type {
  AgentRefView,
  AgentThreadView,
  SessionEventView,
  SessionLineageView,
  SessionProposalView,
  SessionQueuedNoteView,
  SpawnedView,
  WrapUpView,
} from './model-tree.mjs'
import type { SessionWorktreeView } from './model-worktrees.mjs'
import type { Phrase, Text } from './phrase.mjs'
import type { DiffElision } from './text/diff.mjs'
import type { OutputElision } from './text/output-cap.mjs'

export type WireColor =
  | 'blue'
  | 'orange'
  | 'green'
  | 'brown'
  | 'slate'
  | 'red'
  | 'yellow'
  | 'violet'

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'error'

/** harness 的标识由设备服务声明，客户端不写死有哪几种 */
export type HarnessId = string

export interface HarnessView {
  id: HarnessId
  name: string
  /** 两个字母的徽标，例如 CC、PI */
  badge: string
  state: 'ready' | 'unavailable' | 'disabled'
  version: string | null
  /** 不可用时给人看的原因 */
  reason: Text | null
  /** 设备服务对这个原因的原话，给想细看的人。它给了两种语言的就按界面的语言说。没有就是 null */
  detail: Said | null
  /**
   * 不可用是哪一种（设备服务给的分类，例如 notInstalled、versionTooLow）。界面按它说“下一步该怎么办”；
   * 这一版不认识的种类照样带着，界面按一般的“不可用”处理。可用的、对面没说的是 null
   */
  down: string | null
  /** 它事先声明的会什么、不会什么。没有声明的（原生 codex 自己的入口、旧版的适配器）是 null：那就试了才知道 */
  abilities: HarnessAbilities | null
  /**
   * 有没有详情设置（配置项、账号、MCP、指令文件）：设备和它自己的声明里都列了 harnessConfig。
   * 设备声明了而它没有的，界面说“这个 harness 还不支持”
   */
  configurable: boolean
}

/**
 * 一个 harness 声明的、界面用得着的那几样。每一位说的都是“经这个入口实际做得到”。
 * 有声明时界面照它决定入口显不显示；没有声明时入口都在，对面说不认识了再停掉。
 */
export interface HarnessAbilities {
  /** 从某个回合分叉出一个新会话 */
  fork: boolean
  /** 把会话回退到某个回合之前 */
  rollback: boolean
  /** 回退时连那之后改过的文件也照快照恢复（OpenCode 是这样）；不会的只截掉对话 */
  rollbackRestoresFiles: boolean
  /** 分叉、回退能切在回合中间：插进回合的那条用户消息之前（features.revert.byItemId） */
  cutInTurn: boolean
  /** 手动压缩上下文 */
  compact: boolean
  /** 回合进行中把排着的消息插进去（引导） */
  steer: boolean
  /** 引导的时候带不带得了图片。带不了的话，带图的消息只能等回合结束再发 */
  steerImages: boolean
  /** 消息里带不带得了图片 */
  images: boolean
  /** 消息里带不带得了技能（协议里的 skill 输入）。带不了的话输入框里不列技能 */
  skills: boolean
  /**
   * 提到的文件能不能用协议里的 mention 输入带过去。不能的话路径写进正文。
   * 声明里有 mention 还不够：原生 codex 的 mention 是给连接器和插件用的，指向文件的它不放进给模型的话里
   */
  mentions: boolean
  rename: boolean
  archive: boolean
  remove: boolean
  /**
   * 助手消息一开始就带着准的阶段值（声明里的 agentMessagePhase 是 onStart）。
   * 是的话，最终回答一开始活动区就可以收起来，不用等它写完
   */
  finalOnStart: boolean
  /** 发不发本回合的差异。工作目录不是 git 仓库时，差异面板只能靠它 */
  turnDiff: boolean
  /** 能单独停掉一个子代理（对子线程发 turn/interrupt）。子代理页上的“停止”按它出 */
  stopAgent: boolean
  /** 报后台任务的集合（backgroundTasks 扩展）。不报的，界面从已结束回合里还在跑的命令派生 */
  backgroundTasks: boolean
  /** 集合里在跑的命令、监视停得掉（thread/backgroundTerminals/terminate）。后台任务页上命令的“停止”按它出 */
  stopBackground: boolean
  /** 持续目标（thread/goal/*）。不会的不出目标的入口 */
  goals: boolean
  /** 临时分叉带着上下文（声明里的 ephemeralFork）。侧聊靠它，不会的不出侧聊的入口 */
  ephemeralFork: boolean
}

/** 设备服务给的一段话的两种语言版本。核心不认识语言，原样交给界面，界面按当前的语言取 */
export interface Bilingual {
  'zh-CN': string
  en: string
}

/** 对面的原话：只有一种语言的就是一段字，两种都给了的由界面挑 */
export type Said = string | Bilingual

/**
 * 远程设备怎么连。只有这几样：没有密码，也没有密钥的内容。
 * alias：ssh 配置里的一个别名，端口、用户、密钥、跳板机全听用户自己的 ssh 配置；
 * host：手动填的主机，没填的项用 ssh 的默认值。
 */
export type RemoteTarget =
  | { kind: 'alias'; alias: string }
  | {
      kind: 'host'
      host: string
      port: number | null
      user: string | null
      /** 密钥文件的路径。只存路径 */
      keyFile: string | null
    }

/**
 * 连接在哪一步没成。每一步对应界面上一个明确的动作：
 * - unreachable：连不到对面（主机不可达、套接字不存在或没人监听）
 * - hostKey：主机密钥没被信任，或者变了。我们不替用户做这个决定
 * - auth：ssh 认证没过
 * - notInstalled：对面既没有设备服务也没有 codex
 * - outdated：对面的版本太低（codex、适配器的命令行，或者在跑的是一份不带聚合面的旧版设备服务）
 * - startFailed：对面的服务起不来
 * - handshake：通道通了，但握手没成功
 */
export type ConnectStage =
  | 'unreachable'
  | 'hostKey'
  | 'auth'
  | 'notInstalled'
  | 'outdated'
  | 'startFailed'
  | 'handshake'

/**
 * 远程设备没连上之后，该给人看哪一份“怎么办”。阶段相同、该做的事不同的时候靠它分：
 * 同是“版本太低”，升级的可能是 codex，可能是适配器，也可能只是把在跑的旧服务重启一次。
 * - install：对面什么都没有。两条路：装设备服务，或者只装 codex
 * - installCodex / upgradeCodex：对面走的是 codex 这条路，它运行不了、版本太低
 * - upgradeService：对面的适配器太旧，没有设备服务这项功能
 * - restartService：适配器够新，但在跑的那份服务是旧的、不带聚合面，要用户自己把它重启一次
 * 没有这一项的（连不到、主机密钥、认证、起不来）界面按阶段给，或者不给。
 */
export type ConnectGuide =
  | 'install'
  | 'installCodex'
  | 'upgradeCodex'
  | 'upgradeService'
  | 'restartService'

export interface ConnectFailureView {
  stage: ConnectStage
  /** 给人看的原因 */
  text: Text
  /** 对面原话的末尾（ssh 的报错、服务的日志），给“详情”用。没有就是 null */
  detail: string | null
  /** 还会不会自己再试。不会的那些要人处理完再点“重试” */
  retrying: boolean
  /** 该给哪一份“怎么办”，见 ConnectGuide。没有就按阶段给 */
  guide?: ConnectGuide
}

export interface DeviceView {
  id: string
  name: Text
  /** 给人看的主机标识，例如 dev@build-01 */
  host: string
  kind: 'local' | 'ssh'
  /** 远程设备的连接配置。本机是 null */
  target: RemoteTarget | null
  wire: WireColor
  connection: ConnectionState
  /** full：对面是设备服务；single：对面是普通的 Codex 服务，只有一个 harness */
  mode: 'full' | 'single'
  /**
   * 对面的系统：macos、linux、windows（握手应答的 platformOs，设备服务另报过的以它为准）。
   * 路径的另一种写法按它认（text/paths.mts 的 pathTwin）。这次运行里还没连上过是 null，断开之后留着
   */
  os: string | null
  /** 设备所在的时区（IANA 名，设备服务支持定时任务时才报）。不知道是 null 或没有 */
  timezone?: string | null
  harnesses: HarnessView[]
  /**
   * 现在用不了（不可用或已停用）、而侧栏里还留着它上次的会话的 harness。连着的时候才有。
   * 侧栏的设备行据此出一个提示标记；是哪个、为什么，在 harnesses 里各自的状态和原因上
   */
  stranded: HarnessId[]
  /** 离线、重连时的说明；正在连的时候是连到了哪一步；连着的时候是会话目录没取到的原因 */
  note: Text | null
  /** 最近一次没连上的原因。连上了、或者正在重新连的第一步，就清掉 */
  failure: ConnectFailureView | null
  /** 侧栏里的会话是不是上次留下的：还没连上（或者连不上）时拿存着的那份只读地显示 */
  stale: boolean
  /**
   * 这台设备上能不能整理侧栏：工作区的增删改和排序、把会话移到别的工作区、置顶。
   * 对面有“项目”这组方法才行（设备服务声明了设备级的工作区，或者没有声明、问过它确实有）；连着的时候才是 true
   */
  organizable: boolean
  /**
   * 这台设备能不能在这里管理：对面是设备服务，而且它声明了设备配置接口。
   * 单 harness 模式、旧版的适配器都是 false，设备详情只显示连接信息。
   * 连上过之后断开的，留着断开前知道的；这次运行里还没连上过的是 false
   */
  manageable: boolean
  /**
   * 这台设备上正在运行的那份设备服务是哪一版、从哪份适配器起的、什么时候起的、怎么起的（model-service.mts）。
   * 对面是设备服务而且它报了才有；单 harness 模式、不报这一项的旧版服务是 null。
   * 连上过之后断开的，留着断开前知道的；这次运行里还没连上过的是 null
   */
  service: DeviceServiceView | null
  /**
   * 本机设备：最近一次连上时，对“在跑的服务和应用自带的是不是同一版”做了什么。
   * 远程设备、另外指定了入口的本机、还没连上过的都是 null
   */
  upgrade: ServiceUpgradeView | null
  /**
   * 远程设备：在跑的服务比应用旧时的一键升级（model-service.mts 的 RemoteUpgradeView）。
   * 本机设备、不比应用旧又没在升级的都是 null
   */
  remoteUpgrade: RemoteUpgradeView | null
  /**
   * 重启设备服务（侧栏设备行“⋯”里的那一项）：能不能做、做到哪了（model-service.mts 的 ServiceRestartView）。
   * 这一端做不了时是 null：另外指定了入口的本机、外壳没给这项能力的远程设备
   */
  restart: ServiceRestartView | null
  /**
   * 这台设备上的会话能不能用这台桌面端的两项能力（设备设置页的两个开关，存在桌面端、按设备记）。
   * null：这台桌面端根本执行不了这一项（比如不在 macOS 上就没有 Computer Use），设置页不出这个开关
   */
  tools: ToolSwitches
  /**
   * 设备设置页上“操作这台电脑（命令与文件）”一项（model-machine.mts）。
   * 只有远程设备有；本机设备、这台桌面端执行不了 litch_machine 时是 null，设置页不出这一项
   */
  machine: MachineAccessView | null
  /**
   * 设备服务声明了会话树（sessionTree 扩展）：会话上的 Litch 父子关系、提案、手动派子会话都有。
   * 单 harness 模式、旧版的设备服务、设置里关了“会话编排”的都是 false；断开之后留着断开前知道的
   */
  sessionTree: boolean
  /**
   * 设备服务支持扫码绑定手机（设备信息的 extensions 里列了 devicePairing）：设备详情、侧栏的设备菜单里有“在手机上使用…”。
   * 单 harness 模式、旧版的设备服务都是 false；断开之后留着断开前知道的
   */
  pairing: boolean
  /**
   * 设备服务支持给 harness 安装（设备信息的 extensions 里列了 harnessInstall）：设备详情、新建页、首启引导里有安装按钮。
   * 单 harness 模式、旧版的设备服务都是 false，界面退回原来的说明；断开之后留着断开前知道的
   */
  install: boolean
  /**
   * 设备服务能建工作树（设备信息的 extensions 里列了 worktrees，设备上有 git）：新建页有“在哪做”。
   * 单 harness 模式、旧版的设备服务都是 false；断开之后留着断开前知道的
   */
  worktrees: boolean
}

/** 设备设置页上“内置浏览器”“Computer Use”两个开关。默认浏览器开、Computer Use 关 */
export interface ToolSwitches {
  browser: boolean | null
  computer: boolean | null
  /**
   * 按 harness 的开关（键是 harness 标识，设备声明的每个 harness 都有一项）。设置页的“设备 → harness”树按它画，
   * 设备那一格是算出来的（全开、全关、有开有关）
   */
  harnesses?: Record<string, HarnessSwitches>
}

/** 一个 harness 上的三样开关 */
export interface HarnessSwitches {
  /** 任务卡：设备设置 harness.<id>.taskCards（存在设备上）。设备没连着、旧设备服务没有这一项时是 null */
  taskCards: boolean | null
  /** 内置浏览器、Computer Use：存在桌面端，这个 harness 没单独设过时跟设备那一级 */
  browser: boolean
  computer: boolean
}

/** 用户的 ssh 配置里的一台主机 */
export interface DiscoveredHost {
  alias: string
  /** ssh 解析出来的主机名、用户、端口。没解析出来就是 null */
  host: string | null
  user: string | null
  port: number | null
}

/**
 * 添加之前先看一眼对面有什么。先找设备服务，没有再找 codex：
 * - service：装了适配器，连上之后是完整模式。它的服务这时在跑的话顺便问出上面有哪些 harness；
 *   没在跑就不知道（只是看一眼，不替用户启动任何东西），harnesses 是 null
 * - codex：只有原生 codex，连上之后是单 harness 模式
 * 两样都没有、版本太低之类的落在 failure 里
 */
export type RemoteCheck =
  | {
      ok: true
      peer: 'service'
      /** 适配器的版本 */
      version: string
      system: string | null
      /** 它的设备服务现在在不在跑。没在跑的，连的时候会把它拉起来 */
      running: boolean
      harnesses: HarnessView[] | null
    }
  | {
      ok: true
      peer: 'codex'
      version: string
      system: string | null
    }
  | { ok: false; failure: ConnectFailureView }

export interface AppView {
  devices: DeviceView[]
}

export interface WorkspaceView {
  id: string
  name: string
  /** 第一个是主目录 */
  roots: string[]
  /** 用户给它挑的颜色。没挑过是 null */
  color: WireColor | null
  /** 置顶了：和置顶的会话排在一起，在各个组前面。在组里的不会同时置顶 */
  pinned: boolean
  /** 放进了哪个组（自定义分区）。没放、或者那个组已经删了是 null */
  sectionId: string | null
}

/**
 * 用户自己建的一个组（协议里叫自定义分区）。里面可以放会话，也可以放工作区；
 * 空的也画出来，好把东西拖进去
 */
export interface SectionView {
  id: string
  name: string
}

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error'

export interface SessionSummary {
  id: string
  /** null 表示不属于任何工作区 */
  workspaceId: string | null
  harness: HarnessId
  title: Text
  status: SessionStatus
  /** status 为 waiting 时在等什么 */
  waitingFor: 'approval' | 'answer' | null
  unread: boolean
  /** 毫秒时间戳 */
  updatedAt: number
  cwd: string
  /** 置顶了。置顶的会话在设备下面最前头单列一组，不再出现在工作区里 */
  pinned: boolean
  /** 所在的自定义分区（置顶不算）。不在哪个分区里是 null。一个会话同一时间只在一处：置顶，或者一个分区 */
  section: SectionView | null
  /** 进置顶或者进分区的时间，毫秒时间戳。组里按它排，先进去的在前；都不在是 null */
  placedAt: number | null
  /**
   * 和定时任务的关系：任务跑出来的会话、任务的目标会话。侧栏行上出一个“定时”的小记号，
   * 打开之后顶上说是哪个任务。和定时任务无关是 null（model-tasks.mts）
   */
  task: SessionTaskMark | null
  /** 它是哪个会话派出的 Litch 子会话（会话树）。不是子会话的、对面没有会话树的是 null */
  lineage: SessionLineageView | null
  /**
   * 它的子会话交来、还排着没交给模型的回报（会话树），每个子会话最新的一条，按进队列的先后。
   * 对话区末尾当场画出来；没有、对面没有会话树的是空数组
   */
  queuedNotes: SessionQueuedNoteView[]
  pendingRequests?: SessionPendingRequest[]
  delegatedResponses?: SessionDelegatedResponse[]
  /**
   * 别的应用（比如 Claude 桌面端）从另一个会话派出来的原生会话（nativeLineage 扩展）。
   * 侧栏默认不显示它们，“更多”菜单里能打开；认得出父会话的挂在父会话下面。不是的、认不出的是 null
   */
  nativeLineage: NativeLineageView | null
  /**
   * 对面报的后台任务集合（backgroundTasks 扩展，model-background.mts）：回合结束后还在跑的、这次运行里结束过的。
   * 侧栏有任务在跑时出一个慢呼吸的记号。对面不报、一个也没有的是 null；不报的会话打开后由界面派生（projection/background.mts）
   */
  background: SessionBackgroundView | null
  /** 会话所在的设备层工作树（worktrees 扩展，model-worktrees.mts）。不在工作树里的、对面不报的是 null */
  worktree: SessionWorktreeView | null
  /**
   * 这边重启设备服务时它的回合（或后台任务）被打断了：重启完成的时刻（毫秒）。
   * 对话末尾据此说一句“回合被打断，发消息继续”；它再开始一个回合就去掉。只记在这次运行里，没有这回事时不带
   */
  restarted?: number
}

/** 派出这个原生会话的应用。app 是对面报的原样，认不认识由界面定 */
export interface NativeLineageView {
  app: string
  /**
   * 父会话（同一台设备上的会话标识）。认不出是哪一个的是 null。
   * 只是显示用的父子关系：不能从父会话发消息、打断，不唤醒、不回报（那些是 Litch 自己的会话树）
   */
  parentId: string | null
  /** 会话建的时间，毫秒。挂在父会话下面时按它排 */
  createdAt: number
}

export interface SidebarView {
  deviceId: string
  workspaces: WorkspaceView[]
  /** 这台设备上的组，按建的先后。不含置顶 */
  sections: SectionView[]
  sessions: SessionSummary[]
  /** 已归档的会话，最近动过的在前。null：界面还没要过，核心没去取 */
  archived: SessionSummary[] | null
}

/** declined：用户或策略拒绝了这次命令或改动 */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

export interface UserMessageItem {
  id: string
  kind: 'userMessage'
  text: string
  /** 文字之外带的东西：图片、提到的文件、技能。没有名字的（贴进来的图）label 是 null */
  attachments: UserAttachment[]
  /**
   * 设备进程注入在这条消息开头的那一段（子会话的回报、唤醒，<litch-session-event>）认出来的样子。
   * 有它的时候 text 是去掉注入部分之后用户自己说的话（唤醒回合是空的）。没有注入的不带这一项
   */
  event?: SessionEventView
  /**
   * 别的会话发来的消息（peerMessages 扩展的 litchPeer）：不是用户打的字，text 是对方的原文。
   * 界面画成“来自 X 的消息”，不画成用户自己的话
   */
  peer?: PeerView
  /**
   * Litch 替用户发的话（定时任务触发、子会话启动时的简报、提案卡上点的“在这里做”）认出来的样子：
   * 界面画成一张卡片（来源和类型、简略内容，点开看全文），不画成用户自己的话。text 照旧是全文（session-event 去掉之后的）
   */
  system?: SystemMessageView
  /**
   * 提到的会话（正文末尾那一段 <litch-session-mentions> 认出来的，按序号）。有它的时候 text 里没有那一段，
   * 正文里的提及是 ＠[标题]，界面按 mentionSegments 切开画成能点的片。没提到会话的不带这一项
   */
  sessions?: SessionMentionView[]
  /**
   * 本机先显示出来、对面还没回显的插话：还没有对面的条目标识，回退、分叉切不到它（界面不出这两个按钮）。
   * 对面回显后条目照对面的重建，就没有这一项了
   */
  unconfirmed?: true
}

/** Litch 替用户发的话认出来的样子（protocol/src/system-messages.mts） */
export type SystemMessageView = SystemMessage

/** 用户消息里提到的一个会话（同一台设备上） */
export interface SessionMentionView {
  /** 从 1 开始 */
  index: number
  threadId: string
  /** 发出去时写进正文的标题（会话后来改了名也不变） */
  title: string
  harness: string | null
}

/** 发来消息（或者收消息）的那个会话（对方自报，只用来显示和导航） */
export interface PeerView {
  /** 显示名：对方是这台设备上的 Litch 会话时是它的标题。直接写收件箱的外部进程没有 */
  name: string | null
  /** 对方宿主里的会话号：Claude 桌面端的是 local_ 开头 */
  session: string | null
  /** 对方是这台设备上的 Litch 会话时，它的会话号（点了在 Litch 里打开）。认不出没有 */
  thread?: string
  /** 对方是跳过确认（不问就执行工具）的会话 */
  bypass: boolean
}

export interface UserAttachment {
  kind: 'image' | 'audio' | 'file' | 'folder' | 'skill'
  label: string | null
  /** 图片能直接显示时的内容（data URL）。在设备磁盘上的、要联网取的都不给 */
  url?: string
}

/** 随消息发出去的一张图。内容就是 data URL：本地和远程设备走同一条路，不用另外传文件 */
export interface ImageAttachment {
  /** data:image/…;base64,… */
  url: string
  /** 文件名。从剪贴板贴进来的图没有 */
  name: string | null
}

/**
 * 随消息带的、图片之外的东西。
 * - skill：harness 的技能清单里选的一项。path 是它在设备上的位置，发回去时原样带上
 * - text：一大段文字（贴进来的长文本），写消息的时候单独放着，不占输入框。
 *   协议里没有“文本附件”这种输入，发出去时并回正文，跟在打的字后面（见 projection/outgoing.mts）。
 *   name 是给人看的名字，没有就是 null
 */
export type MessageExtra =
  | { kind: 'skill'; name: string; path: string }
  | { kind: 'text'; name: string | null; text: string }
  /**
   * 提到的一个文件或文件夹。path 是 harness 那台机器上的路径：绝对的，或者相对会话的工作目录；文件夹以 / 结尾。
   * client 为真：path 在这台桌面端上、不在会话所在的设备上（远程设备开了“操作这台电脑”时才有），
   * 发出去写进正文末尾的 <litch-client-paths>（protocol/src/client-paths.mts），不走 mention
   */
  | { kind: 'file'; name: string; path: string; folder?: boolean; client?: boolean }
  /**
   * 选中回答里的一段文字加的评论。quote 是选中的原文，note 是用户写的评论（可以是空的），
   * itemId 是那段原文所在的助手条目。发出去时写成正文开头的一段（见 projection/comments.mts）
   */
  | { kind: 'comment'; itemId: string; quote: string; note: string }
  /**
   * 提到的一个会话（输入框里打 @ 选的，正文里是 @[title]）。threadId 是同一台设备上的会话号。
   * 发出去时正文里对上的 @[title] 换成 ＠[title]，末尾加一段 <litch-session-mentions>（projection/session-mentions.mts）。
   * ref 由核心在发出去之前补上（会话的 harness、目录、状态，读不到时的摘录），界面给的不算数
   */
  | { kind: 'session'; threadId: string; title: string; ref?: SessionMentionRef }

/** 要发出去的一条消息 */
export interface OutgoingMessage {
  text: string
  images: ImageAttachment[]
  extras: MessageExtra[]
}

/** harness 上能用的一项技能 */
export interface SkillOption {
  /** 技能的名字，发回去时用的就是它 */
  name: string
  /** 给人看的名字。对面没另外给就是 name */
  title: string
  /** 一句话说明，可能是空的 */
  note: string
  /** 技能在设备上的位置，发回去时原样带上 */
  path: string
  /** 从哪来：用户自己的、仓库里的、系统带的、管理员配的。对面没说、或者说的是这一版不认识的就是 null */
  scope: 'user' | 'repo' | 'system' | 'admin' | null
}

/** 清单里没列出来的一项：哪个位置、对面说的原因（原话） */
export interface SkillProblem {
  path: string
  message: string
}

export interface AgentMessageItem {
  id: string
  kind: 'agentMessage'
  text: string
  /** unknown：这个 harness 分不清过程说明和最终回答 */
  phase: 'commentary' | 'final' | 'unknown'
  status: ItemStatus
  /** 回合中途单独送到用户面前的消息（codex 的 delivery: async）：模型不停下来，接着干活 */
  delivery?: 'async'
  /**
   * 模型边干活边问的问题（codex 的 request_user_input_async），一题一项，按显示顺序。
   * 只有带了题目的才有这一项；答复是下一条用户消息（projection/asks.mts）
   */
  questions?: AskQuestion[]
}

/** 助手消息里带的一道题 */
export interface AskQuestion {
  /** 答复时用的题目标识：[工具名, 协议条目的标识, 第几题] 写成的 JSON，和官方客户端的写法一样 */
  id: string
  title: string
  /** 建议的回答，按显示顺序；没有就是只能自己写 */
  options: string[]
}

export interface ReasoningItem {
  id: string
  kind: 'reasoning'
  text: string
  status: ItemStatus
}

export interface CommandItem {
  id: string
  kind: 'command'
  command: string
  cwd: string
  /**
   * 命令的输出。太长的只留头尾（规矩在 text/output-cap.mts）：没省过时是全部输出，
   * 省过时是开头那一截，中间省了多少、末尾那一截在 elided 里
   */
  output: string
  elided: OutputElision | null
  exitCode: number | null
  durationMs: number | null
  /**
   * 这边看到它开始的时刻（毫秒，本机的钟），给“已经跑了多久”用。
   * 只有看着它开始的才有；从历史里读出来的、接手时已经在跑的都是 null
   */
  startedAt: number | null
  status: ItemStatus
}

export interface FileChangeEntry {
  path: string
  change: 'add' | 'update' | 'delete'
  /** 改名时的新路径 */
  movedTo: string | null
  added: number
  removed: number
  /**
   * 协议给的文本。太长的只留开头那一截（到一行的末尾为止），省掉的和末尾那一截在 elided 里
   * （text/diff.mts 的 capDiff）；画多少由界面决定
   */
  diff: string
  /** patch：diff 是统一格式的补丁；content：diff 是整个文件的内容（新增或删除的文件常见） */
  diffKind: 'patch' | 'content'
  /** 没省过是 null。加了几行、删了几行（added、removed）按省之前的全文数 */
  elided: DiffElision | null
}

export interface FileChangeItem {
  id: string
  kind: 'fileChange'
  changes: FileChangeEntry[]
  status: ItemStatus
}

/**
 * 工具调用的参数或结果里的一段，按先后排。结果是多段的（MCP、动态工具、函数工具都是），按段的种类投影：
 * - text：文字，原样；认不出的段排成 JSON 也是文字。
 * - blob：文字以外的东西（图片、音频、内嵌的资源、资源链接……），只留种类、格式、大小和名字，内容不留，
 *   界面只写一行说明，不去显示、不去取。
 * - gap：太长时中间省掉的地方，整个结果至多一处（规矩在 text/tool-cap.mts，和命令输出的上限是同一套）。
 *   chars、bytes 是省掉的文字有多少个字、多少个 UTF-8 字节；parts 是一并省掉的 blob 有几段。
 */
export type ToolPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'blob'
      /** other：这一版不认识的种类，名字里是对面写的种类 */
      type: 'image' | 'audio' | 'resource' | 'link' | 'other'
      /** 格式，例如 image/png。对面没说是 null */
      mime: string | null
      /** 内容有多少字节（base64 的按解出来算）。只有地址、没有内容的是 null */
      bytes: number | null
      /** 给人看的名字：资源的地址、链接的名字、不是内联的图片地址、不认识的种类。没有是 null */
      name: string | null
      /**
       * 能直接显示的图片（内联的 data: 地址）：界面画成缩略图、点开看大图。只有动态工具（客户端工具的截图）的结果里有，
       * 一个条目至多几张、每张有大小上限（projection/items.mts 的 IMAGE_KEEP、IMAGE_CHARS），别的 blob 没有这一项
       */
      src?: string
    }
  | { kind: 'gap'; chars: number; bytes: number; parts: number }

export interface ToolCallItem {
  id: string
  kind: 'toolCall'
  /** 工具从哪来，例如一个 MCP 服务的名字。说不出来就是 null */
  source: Text | null
  tool: Text
  /** 参数，排成给人看的文本。太长的只留头尾，和结果是同一套规矩；没有参数是空数组 */
  input: ToolPart[]
  /** 结果。还没有结果、或结果是空的时是空数组 */
  output: ToolPart[]
  /**
   * 出错了：对面给的原话按段放（太长的只留头尾，和结果是同一套规矩），或者核心自己的一句话
   * （动态工具只报了失败、没说原因）。没出错是 null
   */
  error: ToolPart[] | Phrase | null
  durationMs: number | null
  status: ItemStatus
  /** 子代理调用（collabAgentToolCall）涉及的子线程，点开在侧面板里看。别的工具调用没有这一项 */
  agents?: AgentRefView[]
  /** litch_sessions.start：派出的 Litch 子会话（或者降成的提案）。别的工具调用没有这一项 */
  spawned?: SpawnedView
  /** litch_sessions.wrap_up：这一回合收尾时的建议任务（每条一张提案）。别的工具调用没有这一项 */
  wrapUp?: WrapUpView
  /** 给别的会话发消息（Claude 的 SendMessage，peerMessages 扩展）：认出来的收件方。认不出、别的工具调用没有这一项 */
  peer?: PeerView
  /**
   * 问用户的工具（Claude 的 AskUserQuestion、OpenCode 的 question、dsh 的 ask_user_question）：题目和用户的回答，
   * 对话里画成问答卡片（projection/asked.mts）。别的工具调用没有这一项
   */
  asked?: AskedView
}

/** 问用户的工具问了什么、用户答了什么 */
export interface AskedView {
  questions: AskedQuestion[]
  /**
   * 结果对不上题目（引擎给的不是每题一行“题头: 回答”）时的原始回答文字，每道题的 answer 都是 null；
   * 对得上、还没有结果时是 null
   */
  raw: string | null
}

export interface AskedQuestion {
  /** 题头（短标签），没有是空的 */
  header: string
  question: string
  options: { label: string; description: string }[]
  /** 用户的回答原文（几项连在一起的照连着）。还没答、没答这一题是 null */
  answer: string | null
  /** 回答里选中的选项，按 options 的下标 */
  picked: number[]
  /** 回答里不是选项的那部分（用户自己写的），没有是 null */
  other: string | null
}

export interface PlanItem {
  id: string
  kind: 'plan'
  text: string
}

export interface WebSearchItem {
  id: string
  kind: 'webSearch'
  /** 搜的词，或者打开的地址 */
  query: string
}

/**
 * 上下文压缩（协议的 contextCompaction）。inProgress：对面发了开始、还没发完成；
 * interrupted：回合结束了还没等到完成，没压成。manual：这边点的压缩（读历史时按回合里没有用户消息认），
 * 别的算自动压缩。压了多久看 span
 */
export interface CompactionItem {
  id: string
  kind: 'compaction'
  status: 'inProgress' | 'completed' | 'interrupted'
  source: 'manual' | 'automatic'
}

/** 一行说明：进入审查模式这类事件，以及这一版客户端不认识的条目类型 */
export interface NoticeItem {
  id: string
  kind: 'notice'
  label: Text
  detail: string | null
}

/** 待办里的一步。inProgress：正在做的那一步 */
export interface TodoStep {
  text: string
  status: 'pending' | 'inProgress' | 'completed'
}

/**
 * 待办进度：模型自己列的几步，做到哪了。一个回合里只有一个，模型每改一次整份换掉，条目的标识不变。
 * 回合结束之后留在对话里；那时还标着“正在做”的步骤算没做完。
 */
export interface TodoItem {
  id: string
  kind: 'todo'
  /** 模型改这份待办时附的一句说明，可能没有 */
  note: string | null
  steps: TodoStep[]
}

export type ItemView = (
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandItem
  | FileChangeItem
  | ToolCallItem
  | PlanItem
  | WebSearchItem
  | NoticeItem
  | CompactionItem
  | TodoItem
) & {
  /**
   * 这边看到它开始、结束的时刻（毫秒，本机的钟；projection/span.mts 的 spanned 在增量发出之前记上）。
   * 步骤组的时长按组里第一条开始到最后一条结束算。从历史里读出来的没有这一项
   */
  span?: ItemSpan
}

/** 条目从开始到结束。to 是 null：还没结束 */
export interface ItemSpan {
  from: number
  to: number | null
}

export type TurnStatus = 'running' | 'completed' | 'interrupted' | 'failed'

export interface TurnView {
  id: string
  status: TurnStatus
  /** 条目的顺序。条目内容在 SessionView.items 里按标识取 */
  itemIds: string[]
  /** 毫秒时间戳。对面没给就是 null */
  startedAt: number | null
  durationMs: number | null
  /** 回合失败时给人看的原因 */
  error: string | null
  /** 不是用户发起的回合是怎么开始的（后台任务结束后接着做、定时任务触发）。用户发的不带 */
  origin?: Exclude<TurnOrigin, 'user'>
  /** 回合里的模型请求正在重试（apiRetry 扩展）。没在重试不带或是 null */
  retry?: TurnRetryView | null
}

/** 模型请求在重试：状态行写“重试中 第几次/最多几次”和原因 */
export interface TurnRetryView {
  attempt: number
  /** 最多几次；harness 没说是 null，只写第几次 */
  maxRetries: number | null
  reason: ApiRetryReason
  /** 失败那次的 HTTP 状态码；连接错误没有 */
  httpStatus: number | null
}

/**
 * 审批卡片上的一个按钮。有哪些按钮由请求自己带来，界面不按请求类型写死。
 * role 决定样式和快捷键：accept 是主按钮（回车），decline 是拒绝（Esc）。
 */
export interface ApprovalOption {
  id: string
  role: 'accept' | 'acceptSession' | 'acceptAlways' | 'decline' | 'cancel'
  /** 选这一项时可以附一句说明，随决定带给对面，模型看得到。对面声明了才有，现在只会出现在“拒绝”上 */
  note?: boolean
  /**
   * “以后都允许”记下来的是什么：一条命令的前缀，或者一个可以访问的主机。原文照出，给人在点之前看一眼。
   * 别的选项没有
   */
  rule?: string
}

export interface ApprovalRequest {
  id: string
  kind: 'approval'
  /** tool：MCP 服务的一次工具调用 */
  subject: 'command' | 'fileChange' | 'permissions' | 'tool'
  /** 对话流里与它对应的条目（那条命令、那次改动）。对不上就是 null */
  itemId: string | null
  command: string | null
  cwd: string | null
  /** 对面给的理由，原文 */
  reason: string | null
  /** 请求额外权限时要的是什么。别的审批是 null */
  permissions: { network: boolean; read: string[]; write: string[] } | null
  /** 工具调用的审批：哪个服务的哪个工具、带什么参数（排好版的 JSON）。别的审批是 null */
  tool: { server: string; title: string | null; note: string | null; params: string | null } | null
  options: ApprovalOption[]
}

export interface QuestionView {
  id: string
  header: string
  question: string
  /** null 表示没有选项，只能自己填 */
  options: { label: string; description: string }[] | null
  /** 选项之外可以自己填。只看对面在题目上给的标记，不看选项叫什么（见 projection/questions.mts） */
  allowOther: boolean
  /** 答案要遮住（密码之类） */
  secret: boolean
}

export interface QuestionRequest {
  id: string
  kind: 'question'
  itemId: string | null
  questions: QuestionView[]
}

/** 表单里的一栏 */
export interface FormField {
  id: string
  label: string
  /** 对面给的说明，可能是空的 */
  note: string
  required: boolean
  /** text：一行字；number、integer：数；boolean：是或否；choice：选一个；choices：选几个 */
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices'
  /** 文字的格式，界面据此换输入框的类型 */
  format: 'email' | 'uri' | 'date' | 'date-time' | null
  /** choice、choices 能选的 */
  options: { value: string; label: string }[]
  /** 一开始填着的值 */
  initial: string | number | boolean | string[] | null
  /**
   * 对面给这一栏定的范围，没定的是 null。数（number、integer）看 min、max；字（text）看 minLength、maxLength。
   * 界面提交之前照它查：不合的值对面会拒掉，而且不告诉用户
   */
  limits: FormLimits
}

export interface FormLimits {
  min: number | null
  max: number | null
  minLength: number | null
  maxLength: number | null
}

/** MCP 服务要用户填的一张表，或者要用户去一个网页上办的一件事 */
export interface FormRequest {
  id: string
  kind: 'form'
  itemId: string | null
  /** 是哪个 MCP 服务在问 */
  server: string
  message: string
  /** 一栏都没有的表就是一句确认 */
  fields: FormField[]
  /** 不是填表：要用户去这个网址办完再回来。openable 为假说明地址不是普通的网页地址，界面不给打开 */
  link: { url: string; openable: boolean } | null
}

/** 客户端工具要用户点头的事：文字由界面按结构和语言拼（和桌面端的 ClientToolAsk 同形） */
export type ClientAskView =
  | { kind: 'chromeSignIn'; origin: string; reason: string }
  | {
      kind: 'site'
      /** 要访问的网站来源，比如 https://example.com */
      origin: string
      url: string
      browser?: 'chrome'
    }
  | SignInAskView
  | MachineAskView

/**
 * 代理请人登录（内置浏览器的 request_sign_in）：和桌面端的 ClientToolAsk 里 signIn 那种同形，和浏览器面板上那张
 * 是同一张（id 是它的编号）。界面经外壳 signIn.answer(id, …) 答，不走核心的答复；只在等人选的时候挂着。
 * 样子见界面的 composer/SignInAskCard.tsx
 */
export interface SignInAskView {
  kind: 'signIn'
  /** 登录卡片的编号（桌面端主进程的 SignInRequest.id） */
  id: string
  /** 主进程取到的标签的真实来源 */
  origin: string
  /** 代理说的站名、原因，只作附注 */
  site: string
  reason: string
  /** 密码库里和 origin 完全一样的账号，最近用过的在前。ref 是这张卡片里随机的编号；给手机的只用 masked */
  accounts: { ref: string; username: string; masked: string; lastUsed: number | null }[]
  /** 预检不过、不能代填的原因，能代填是 null */
  fillBlocked: string | null
  /** 定时任务的回合才有：多一个“以后直接用这个账号”的勾选 */
  taskId: string | null
  /** 毫秒，只有定时任务的回合有 */
  expiresAt: number | null
  /** 桌面端出的随机数：转给手机，手机的答复要签上它 */
  nonce: string
  /** 哪台桌面端出的（主进程放上，核心转给手机时用），界面不画 */
  desktopId?: string | null
}

/**
 * 这台桌面端在执行一次客户端工具调用（内置浏览器、Computer Use）时要用户点头。
 * 由桌面端自己发起、自己答，不是对面的请求；样子和审批卡片一样，排在同一处
 */
export interface ClientAskRequest {
  id: string
  kind: 'clientAsk'
  /** 对话流里那次工具调用的条目。对不上是 null */
  itemId: string | null
  /** 调用来自哪台设备上的会话。远程设备要显眼：那是别的机器上的模型在用这台电脑 */
  device: { name: Text; kind: 'local' | 'ssh'; host: string }
  /** 哪个命名空间的哪个工具在问 */
  tool: { namespace: string; name: string }
  ask: ClientAskView
  /** accept 是“仅这一次”，acceptSession 是“这个会话里都允许”，acceptAlways 是“一直允许”，decline 是拒绝 */
  options: ApprovalOption[]
}

/** 对面停下来等人答复的一件事 */
export type RequestView = ApprovalRequest | QuestionRequest | FormRequest | ClientAskRequest

/**
 * 一个会话眼下的情况，系统通知的正文用（session.peek）：最近一个回合最后一条回答、回合失败的原因、
 * 停下来等人处理的那件事。都是原文，掐字、加前缀由界面做；拿不到的是 null
 */
export interface SessionPeek {
  answer: string | null
  error: string | null
  pending: SessionPeekPending | null
}

/** 等人处理的那件事：要跑的命令、要改的文件、要调的工具、要的权限、要答的题、要填的表，别的归 other */
export interface SessionPeekPending {
  kind: 'command' | 'fileChange' | 'tool' | 'permissions' | 'question' | 'form' | 'other'
  text: Text
}

/** 回合进行中发的消息先排着，回合结束后按顺序发出去 */
export interface QueuedMessage extends OutgoingMessage {
  id: string
}

/** 一档思考强度 */
export interface EffortOption {
  id: string
  /** 对面给的一句话说明，可能是空的 */
  note: string
}

/** 一个可选的模型 */
export interface ModelOption {
  /** 发给对面的模型标识 */
  id: string
  title: string
  /** 空的：这个模型没有强度的概念，界面不显示强度控件 */
  efforts: EffortOption[]
  defaultEffort: string | null
  /**
   * 这个模型能换的速度档（Codex 的 service tier，比如快速是 priority）。标准速度不在里面，界面自己补那一档。
   * 空的：没有速度可选，界面不显示速度控件
   */
  speeds: SpeedOption[]
  /** 没选过速度时这个模型用的那一档。null 是标准速度 */
  defaultSpeed: string | null
  isDefault: boolean
  /** 这个模型收不收图片 */
  acceptsImages: boolean
}

/** 一档速度：发给对面的标识，和对面给的名字、说明 */
export interface SpeedOption {
  id: string
  title: string
  note: string
}

/**
 * 一档权限预设。harness 声明了自己有哪几档的，标题和说明用它给的（两种语言）；
 * 没有声明时是 Codex 协议内置的三档，标题和说明是 null，由界面按标识去说，界面不认识的标识照原样显示
 */
export interface PermissionPreset {
  id: string
  risk: 'low' | 'medium' | 'high'
  title: Bilingual | null
  note: Bilingual | null
  /** 换到这一档之前要不要再问一遍 */
  confirm: boolean
  /** 会话建好之后还能不能换到这一档。不能的只在新建会话时选得了 */
  switchable: boolean
}

/** 在这台设备上发消息时能选什么 */
export interface ComposeOptions {
  models: ModelOption[]
  permissions: PermissionPreset[]
  /** 这个 harness 会不会计划模式（先出计划、确认之后再动手）。不会的话界面不出这个入口 */
  plan: boolean
  /**
   * 清单里藏起来的型号（会话还用着、新建时不给选，比如供应商删掉了）的显示名，按型号标识。
   * 底栏上会话用着它时照样显示成名字，不露原始标识
   */
  hiddenTitles?: Record<string, string>
}

/** 协作模式：default 是照常干活，plan 是先出计划 */
export type SessionMode = 'default' | 'plan'

/** 会话用的模型、强度、速度、权限预设、协作模式。null：对面没说，或者是预设之外的组合 */
export interface SessionSettings {
  model: string | null
  effort: string | null
  /** 速度档的标识，标准速度是 STANDARD_SPEED。null：没选过，用模型自己的默认档 */
  speed: string | null
  permission: string | null
  mode: SessionMode | null
}

/**
 * 在这个 harness 上不带设置新建会话时，对面会用的模型、强度、权限预设（device.newSessionDefaults）。
 * 照上游的取法从 configRequirements/read 和 config/read 里算（projectDefaults）。null：对面没说
 */
export interface SessionDefaults {
  model: string | null
  effort: string | null
  speed: string | null
  permission: string | null
}

/** 上下文占了多少。对面报过才有 */
export interface ContextUsage {
  /** 最近一次模型请求用掉的词元数，也就是现在上下文里有多少 */
  usedTokens: number
  /** 模型的上下文窗口有多大。对面没报就是 null，这时算不出占比 */
  windowTokens: number | null
}

/**
 * 这个会话上几件不是每个引擎都会的事，对面做不做得了。
 * 它所属的 harness 有声明就照声明（declared 为真）：不会的事界面不出入口。
 * 没有声明时先当它都会，哪件事对面说“不认识”就记成不会，界面把那个入口停掉并说明。
 * 有声明的也一样会被“试了不行”改写：声明说会、对面却说不认识的，照实际的来。
 */
export interface SessionAbilities {
  /** 从某个回合分叉出一个新会话 */
  fork: boolean
  /** 把会话回退到某个回合之前 */
  rollback: boolean
  /** 回退时连那之后改过的文件也照快照恢复（OpenCode 是这样）；不会的只截掉对话 */
  rollbackRestoresFiles: boolean
  /**
   * 分叉、回退能切在回合中间（插进回合的那条用户消息之前）。只认声明，没声明的当它不会：
   * 插进去的话上不出这两个入口
   */
  cutInTurn: boolean
  /** 手动压缩上下文 */
  compact: boolean
  /** 回合进行中把排着的消息插进去（引导） */
  steer: boolean
  /** 引导的时候带不带得了图片 */
  steerImages: boolean
  /** 最终回答一开始就知道它是最终回答。没有声明的当它不知道，等消息写完再认 */
  finalOnStart: boolean
  /** 对面报后台任务的集合（SessionSummary.background）。不报的当它不报，界面自己从会话里派生 */
  backgroundTasks: boolean
  /**
   * 持续目标（thread/goal/*，model-goal.mts）。只认声明：没声明的 harness 当它不会，不出入口；
   * 声明了、调用时对面说没有这个方法或者关着这个特性的，记成不会
   */
  goals: boolean
  /**
   * 侧聊：从这个会话临时分出一段对话（带着它的上下文，不进侧栏，关掉就扔）。只认声明（ephemeralFork），
   * 没声明的当它不会，不出入口
   */
  sideChat: boolean
  /** 这几项是照 harness 的声明给的，不是先当它会 */
  declared: boolean
}

/** 试了才知道的那几件事 */
export type SessionAbility = 'fork' | 'rollback' | 'compact' | 'steer' | 'goals'

export interface SessionView {
  deviceId: string
  sessionId: string
  title: Text
  harness: HarnessId
  cwd: string
  /** 能不能在这个会话里发消息。只读载入（订阅失败退回到只取历史）时是 false */
  live: boolean
  /** 给人看的说明：为什么只读、排队的消息为什么没发出去 */
  note: Text | null
  turns: TurnView[]
  items: Record<string, ItemView>
  /** 等人答复的请求，按到达顺序。界面一次只呈现第一个 */
  requests: RequestView[]
  queued: QueuedMessage[]
  /** 下一个回合会用的设置：对面报的，加上用户在这边改了还没发出去的 */
  settings: SessionSettings
  /** 上下文占用。对面还没报过就是 null */
  usage: ContextUsage | null
  can: SessionAbilities
  /**
   * 从哪个会话分叉出来的（对面在会话对象上报的 forkedFromId，记在会话里，读历史时也有）。
   * 不是分叉出来的、对面不报的是 null；子代理会话照着上一级起的那一层不算
   */
  forkedFrom: string | null
  /**
   * 模型提的子会话提案（会话树的建议任务），等着的和了结的都在，先提的在前。
   * 对话流里画在提出它的那次 litch_sessions.start 上，侧面板“建议任务”列全部
   */
  proposals: SessionProposalView[]
  /**
   * 引擎自己派出的子代理线程，带着各自的状态（子线程自己的回合）。对话流里子代理那一行、侧面板的“子代理”页
   * 都按它写状态。设备还没列过、没有子代理是空的
   */
  agents: AgentThreadView[]
  /** 会话的持续目标（model-goal.mts）。没有目标、harness 不会的不带或是 null */
  goal?: SessionGoalView | null
  /** 刚达成、已经清掉的目标留下的那一句（model-goal.mts）。没有是 null 或不带 */
  goalReached?: GoalReachedView | null
  /**
   * 这是上次留下的旧视图（这台电脑上存的、或者核心留着但订阅已经断了的），最新的还在载入，到了整份换掉。
   * 这时 live 为假，界面照样画、输入框能写但发不出（device/view-store.mts）。最新的视图不带这一项
   */
  stale?: boolean
}
