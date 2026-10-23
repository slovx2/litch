// 界面与核心之间那条通道的约定：有哪些主题、增量长什么样、有哪些命令、线上发什么消息。
// 通道只有两种用法：命令（一问一答，可取消）和订阅（先快照，后增量）。
import type {
  AppView,
  Bilingual,
  ComposeOptions,
  ContextUsage,
  DeviceView,
  DiscoveredHost,
  ImageAttachment,
  ItemStatus,
  ItemView,
  MessageExtra,
  QueuedMessage,
  RemoteCheck,
  RemoteTarget,
  RequestView,
  SessionAbilities,
  SessionDefaults,
  SessionSettings,
  SessionSummary,
  SessionView,
  SidebarView,
  SkillOption,
  SkillProblem,
  TurnStatus,
  TurnView,
  WireColor,
  WorkspaceView,
} from '../model.mjs'
import type { ConfigTopicOp, ConfigTopicView } from '../model-config.mjs'
import type {
  DiffBundle,
  DiffRequests,
  DiffScope,
  DiffStatus,
  DiffView,
  FileDiff,
} from '../model-diff.mjs'
import type { DirectoryView, FileContent, FileSearchView } from '../model-files.mjs'
import type { GoalChange, GoalReachedView, SessionGoalView } from '../model-goal.mjs'
import type {
  HarnessConfigTopicView,
  HcEdit,
  HcMcpServer,
  HcModelEntry,
  HcPart,
  HcValue,
  InstructionsLinkResult,
  InstructionsOverview,
} from '../model-harness-config.mjs'
import type {
  HarnessInstallTarget,
  HarnessVersionView,
  InstallTopicView,
} from '../model-install.mjs'
import type { AccountLimitsView } from '../model-limits.mjs'
import type {
  MachineAccessMode,
  MachineActivityView,
  MachineApproval,
  MachineLogEntry,
  MachineOp,
} from '../model-machine.mjs'
import type {
  DiagnosticsView,
  HarnessRestartResult,
  LogSource,
  LogTailView,
  ManageView,
  SettingEditView,
  SettingsSnapshotView,
  SettingsWriteResult,
  SshConfigView,
} from '../model-manage.mjs'
import type {
  PairingAddress,
  PairingTarget,
  PairingTopicView,
  PairingView,
  PairMode,
  PairPhone,
  PairStatus,
} from '../model-pairing.mjs'
import type { TaskDraft, TaskPatch, TaskRunView, TasksView, TaskView } from '../model-tasks.mjs'
import type {
  TerminalHave,
  TerminalOp,
  TerminalStreamView,
  TerminalsOp,
  TerminalsView,
} from '../model-terminal.mjs'
import type {
  AgentThreadView,
  LineageKind,
  OfferChoice,
  ProposalOverrides,
  SandboxLevel,
  SessionProposalView,
} from '../model-tree.mjs'
import type {
  WorktreeBranchesView,
  WorktreeFrom,
  WorktreesTopicView,
  WorktreeView,
} from '../model-worktrees.mjs'
import type { Phrase, Text } from '../phrase.mjs'
import type { SkippingOutput } from '../text/output-cap.mjs'

// ---------- 主题 ----------

export type Topic =
  | { kind: 'app' }
  | { kind: 'sidebar'; deviceId: string }
  | { kind: 'session'; deviceId: string; sessionId: string }
  /**
   * 一台设备的管理数据：设置的结构和现在的值。界面开着设备详情时才订阅。
   * 设备没有设置接口时订阅以 unsupported 结束；没连上时订阅照样成立，连上之后才有快照，重连之后再给一份
   */
  | { kind: 'manage'; deviceId: string }
  /**
   * 一台设备上的终端有哪些、各自什么状态。设备没连上时订阅照样成立：
   * 断线之前开着的标签还在，只是状态变了
   */
  | { kind: 'terminals'; deviceId: string }
  /**
   * 一个终端的输出。快照只说从哪开始，字节全部走增量。
   * have：这个界面手里已经有到哪了（退订过再订阅时给），核心只补后面的
   */
  | { kind: 'terminal'; deviceId: string; terminalId: string; have?: TerminalHave }
  /**
   * 一个根里现在有哪些没提交的改动（哪些文件、各增删多少行）。差异面板开着时才订阅：有人订阅，核心才去设备上取。
   * root 是工作区的根（不属于工作区的会话是它的工作目录）；scope 是拿什么和什么比；
   * sessionId 是眼前的会话：这个目录看不了 git 的时候，用这个会话的 harness 给的本回合差异。
   * 设备没连上时订阅照样成立，连上之后才有内容
   */
  | { kind: 'diff'; deviceId: string; root: string; scope: DiffScope; sessionId: string | null }
  /**
   * 远程会话在这台电脑上的动静：还在跑的进程、找不到会话的待处理卡片。
   * 顶栏标记一直订阅；什么都没有时两样都是空的
   */
  | { kind: 'machine' }
  /**
   * 一台设备上的定时任务（deviceTasks 扩展）。数据副本对每台设备一直订阅着：侧栏入口的未读合计、
   * 会话上的“定时”记号、运行结束的系统通知都要它。设备没有这项扩展时快照里 available 是 false，
   * 照样成立；没连上时给上次知道的（还没连上过是 null）。连上、重连之后再给一份快照
   */
  | { kind: 'tasks'; deviceId: string }
  /**
   * 一台设备上扫码绑定手机的情况（devicePairing 扩展）：已绑定的手机，和这台桌面端开出来的配对现在走到哪了。
   * 设备详情、出码对话框开着时才订阅。设备没有这项扩展时快照里 available 是 false，照样成立；
   * 没连上时给上次知道的（还没连上过是 null）。连上、重连之后再给一份快照
   */
  | { kind: 'pairing'; deviceId: string }
  /**
   * 一台设备上给 harness 安装的情况（harnessInstall 扩展）：各 harness 的版本、在跑和刚结束的安装任务。
   * 设备详情、新建页“没有可用的 harness”、首启引导开着时才订阅，有人订阅核心才去问版本。
   * 设备没有这项扩展时快照里 available 是 false，照样成立；没连上时给上次知道的。连上、重连之后再给一份快照
   */
  | { kind: 'install'; deviceId: string }
  /**
   * 一台设备上一个 harness 的详情设置（harnessConfig 扩展）：配置项、账号与 provider、MCP、指令文件、进行中的登录。
   * 详情设置页开着时才订阅，有人订阅核心才去读；别处改了（config/changed）重读那一块。
   * 设备或 harness 不支持时快照里 supported 是 false，照样成立；没连上时给上次知道的。连上、重连之后再读一遍
   */
  | { kind: 'harnessConfig'; deviceId: string; harness: string }
  /**
   * 一台设备上一个 harness 的账号额度（account/rateLimits/read）。用量环的弹层开着时才订阅，有人订阅核心才去读；
   * 之后跟着 account/rateLimits/updated。没有额度、harness 不认识这个方法时 rows 是空的，照样成立；
   * 没连上时给上次知道的，连上、重连之后再读一遍
   */
  | { kind: 'accountLimits'; deviceId: string; harness: string }
  /**
   * 配置 Litch（litch_config 执行器）要界面做的事和挂着的确认卡。要做的事只发给一个窗口（最近订阅的那个），
   * 确认卡每个窗口都有。应用的外框一直订阅着
   */
  | { kind: 'config' }
  /**
   * 一台设备上设备层建的工作树（worktrees 扩展）：设置页的“工作树”一块开着时才订阅，有人订阅核心才去读；
   * 之后跟着 litch/worktree/changed。设备没有这项扩展时快照里 available 是 false，照样成立；
   * 没连上时给上次知道的。连上、重连之后再读一遍
   */
  | { kind: 'worktrees'; deviceId: string }

export type TopicKind = Topic['kind']

export interface TopicData {
  app: AppView
  sidebar: SidebarView
  session: SessionView
  manage: ManageView
  terminals: TerminalsView
  terminal: TerminalStreamView
  diff: DiffView
  machine: MachineActivityView
  tasks: TasksView
  pairing: PairingTopicView
  install: InstallTopicView
  harnessConfig: HarnessConfigTopicView
  accountLimits: AccountLimitsView
  config: ConfigTopicView
  worktrees: WorktreesTopicView
}

// ---------- 增量 ----------
// 增量是有语义的操作，不是通用的 JSON 补丁：界面可以据此只通知订阅了那一个条目的组件。

export type AppOp =
  | { op: 'device.upsert'; device: DeviceView }
  | { op: 'device.remove'; deviceId: string }

export type SidebarOp =
  | { op: 'workspace.upsert'; workspace: WorkspaceView }
  | { op: 'workspace.remove'; workspaceId: string }
  | { op: 'session.upsert'; session: SessionSummary }
  | { op: 'session.remove'; sessionId: string }
  /** 已归档的会话整张表换掉：这张表不长，变得也少 */
  | { op: 'archived.set'; sessions: SessionSummary[] | null }

export type SessionOp =
  | { op: 'turn.add'; turn: TurnView }
  /** 撤掉一个回合连同它的条目：先显示出来的消息没发成功 */
  | { op: 'turn.remove'; turnId: string }
  | {
      op: 'turn.status'
      turnId: string
      status: TurnStatus
      durationMs: number | null
      /** 不带这个字段表示出错原因不变 */
      error?: string | null
      /** 回合的来历（TurnView.origin）。不带表示不变：有的入口只在回合结束时才给 */
      origin?: NonNullable<TurnView['origin']>
    }
  /** 加一个条目；标识已经有了就整个换掉（条目定稿时对面会给出完整的最终内容） */
  | { op: 'item.add'; turnId: string; item: ItemView }
  | { op: 'item.appendText'; itemId: string; field: 'text' | 'output'; text: string }
  /**
   * 往命令输出后面接一大段，中间一截只带着字数和字节数。核心自己不发它：通道把同一帧里接到同一条命令输出上的字
   * 并起来，太长时换成它（channel/server.mts），收的一方用 appendSkipping 接，结果和整段接的一模一样
   */
  | ({ op: 'item.appendOutput'; itemId: string } & SkippingOutput)
  | { op: 'item.status'; itemId: string; status: ItemStatus }
  /** 撤掉一个条目：插进回合里的那句话没发成功 */
  | { op: 'item.remove'; turnId: string; itemId: string }
  | { op: 'request.add'; request: RequestView }
  | { op: 'request.remove'; requestId: string }
  | { op: 'queue.set'; queued: QueuedMessage[] }
  | { op: 'session.state'; live: boolean; note: Text | null }
  | { op: 'session.settings'; settings: SessionSettings }
  | { op: 'session.usage'; usage: ContextUsage | null }
  /** 对面做不做得了的几件事变了（刚发现有一件它不认识） */
  | { op: 'session.can'; can: SessionAbilities }
  /** 这个会话上等着用户点的子会话提案整份换掉（会话树） */
  | { op: 'session.proposals'; proposals: SessionProposalView[] }
  /** 这个会话的子代理（引擎自己派出的子线程）整份换掉：派了新的，或者哪个的状态变了 */
  | { op: 'session.agents'; agents: AgentThreadView[] }
  /** 持续目标整个换掉（设了、改了状态和用量）；null 是清掉了 */
  | { op: 'session.goal'; goal: SessionGoalView | null }
  /** 目标达成了、清掉了，回答下面那一句换掉；null 是不再写（设了新目标） */
  | { op: 'session.goalReached'; reached: GoalReachedView | null }

/**
 * 设置现在的值整份换掉：这份东西不大，变得也少。
 * keys 是这一次变了的键（自己写的、别处写的都算）：界面据此知道用户正在改的那一栏是不是被别处动过
 */
export type ManageOp = { op: 'settings.set'; snapshot: SettingsSnapshotView; keys: string[] }

/** 差异的概况整份换掉：它不大，而且每次重新取，变的往往是其中好几处 */
export type DiffOp = { op: 'diff.set'; view: DiffView }

/**
 * 定时任务的增量。任务整条换（它不大，变的往往是好几项：下一次、最近一次、未读数一起变）。
 * run.upsert 是一次运行开始、结束、标成看过了：详情页开着的运行记录据此更新。
 * finished 为真：这一条是核心看着这次运行结束的（连着的时候收到的通知），界面据此发系统通知；
 * 对账时补上的、标成看过了的都是 false
 */
export type TasksOp =
  | { op: 'task.upsert'; task: TaskView }
  | { op: 'task.remove'; taskId: string }
  | { op: 'run.upsert'; run: TaskRunView; finished: boolean }

/**
 * 扫码绑定手机的增量。已绑定的手机整份换（不长，变得也少）；
 * 一个配对的状态整条换（只有这台桌面端开出来的配对才有，别处开的不发）
 */
export type PairingOp =
  | { op: 'phones.set'; phones: PairPhone[]; tailscale: boolean }
  | { op: 'pair.status'; status: PairStatus }

/** 安装情况整份换：不大，一次变的往往是好几项（任务的日志、状态，接着版本也重新探测） */
export type InstallOp = { op: 'install.set'; view: InstallTopicView }

/** 详情设置整份换：一次变的往往是一整块（重读了 providers），按块拆增量不划算 */
export type HarnessConfigOp = { op: 'hc.set'; view: HarnessConfigTopicView }

/** 账号额度整份换：只有几行 */
export type AccountLimitsOp = { op: 'limits.set'; view: AccountLimitsView }

/** 工作树的列表整份换：不长，变得也少 */
export type WorktreesOp = { op: 'worktrees.set'; view: WorktreesTopicView }

export interface TopicOp {
  app: AppOp
  sidebar: SidebarOp
  session: SessionOp
  manage: ManageOp
  terminals: TerminalsOp
  terminal: TerminalOp
  diff: DiffOp
  machine: MachineOp
  tasks: TasksOp
  pairing: PairingOp
  install: InstallOp
  harnessConfig: HarnessConfigOp
  accountLimits: AccountLimitsOp
  config: ConfigTopicOp
  worktrees: WorktreesOp
}

// ---------- 命令 ----------

export interface Commands {
  /** 核心的基本信息。界面启动时用它确认通道是通的 */
  'core.info': { params: Record<string, never>; result: { version: string; mock: boolean } }
  /** 把一个会话标成已读 */
  'session.markRead': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /**
   * 发一条消息，可以带图片和别的东西（extras：技能）；带着这些时文字可以是空的。
   * 没有回合在进行就立刻开始一个回合，否则排队。
   * now：有回合在进行时不排队，直接插进这个回合（答模型边干活边问的题就是这样，和官方客户端一样）；
   * 插不进去（对面不会、带着图）就照常排着，等这个回合结束再发。
   * 应答表示“已经受理”（回合开始了，或者排上了队）；出错时界面要把文字和带的东西还给用户。
   */
  'session.send': {
    params: {
      deviceId: string
      sessionId: string
      text: string
      images?: ImageAttachment[]
      extras?: MessageExtra[]
      now?: boolean
    }
    result: Record<string, never>
  }
  /**
   * 建一个会话并发出第一条消息。cwd 给 null 表示不属于任何工作区，工作目录由对面定。
   * 应答时会话已经建好、第一个回合已经开始；出错时界面要把文字还给用户。
   * harness：建在哪个 harness 上。设备上不止一个 harness（完整模式）时由界面给；
   * 没给就用第一个可用的。只有一个 harness 的设备不看它。
   * workspaceId：建在哪个工作区里。给了，会话从一开始就归在那里；不给就按工作目录去认。
   */
  'session.create': {
    params: {
      deviceId: string
      harness?: string
      workspaceId?: string
      cwd: string | null
      text: string
      images?: ImageAttachment[]
      extras?: MessageExtra[]
      settings?: Partial<SessionSettings>
      /**
       * text 是持续目标（输入框里的 /goal）：建好会话后设下目标（thread/goal/set），不发消息，
       * harness 空闲时自己开始做。这时不带图片和附带项。harness 不会持续目标的报 unsupported
       */
      goal?: boolean
      /**
       * 在新工作树里建（设备列了 worktrees、cwd 在 git 仓库里才能用）：设备先从 from（不给是仓库默认分支）
       * 建一个工作树，会话在里面对应的子目录起，大仓库可能要几十秒。建不成以 rejected 结束，不留空会话
       */
      worktree?: { from?: WorktreeFrom }
    }
    result: { sessionId: string }
  }
  /** 改这个会话的模型、强度、权限预设。从下一个回合起生效 */
  'session.configure': {
    params: { deviceId: string; sessionId: string; settings: Partial<SessionSettings> }
    result: Record<string, never>
  }
  /**
   * 分叉：建一个新会话，里面是这个会话到 turnId 这个回合为止（含）的内容。原来的会话不动。
   * 应答时新会话已经在侧栏里。有回合在进行时不能分叉。
   */
  'session.fork': {
    /**
     * 不带 itemId：带上到 turnId 这个回合为止（含这一回合）。带 itemId（这个回合里插进去的一条用户消息）：
     * 这一回合只带到它之前。要会话的 can.cutInTurn
     */
    params: { deviceId: string; sessionId: string; turnId: string; itemId?: string }
    result: { sessionId: string }
  }
  /**
   * 回退：把 turnId 这个回合和它后面的回合都从会话里撤掉，找不回来。
   * 只改会话的历史，已经对文件做的改动不会还原。有回合在进行时不能回退。
   * 带 itemId（这个回合里插进去的一条用户消息）时只撤掉它和它之后的，这一回合前面的留着。要会话的 can.cutInTurn
   */
  'session.rollback': {
    params: { deviceId: string; sessionId: string; turnId: string; itemId?: string }
    result: Record<string, never>
  }
  /**
   * 压缩上下文：让对面把之前的对话总结一遍，腾出上下文。
   * 应答表示对面受理了；压缩本身作为一个回合进行，结果照常从会话的增量里来。
   */
  'session.compact': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /**
   * 执行计划：退出计划模式，并以 text 这句话发起一个回合（话由界面按当前的语言给）。
   * 回合还在进行的时候做不了
   */
  'session.implementPlan': {
    params: { deviceId: string; sessionId: string; text: string }
    result: Record<string, never>
  }
  /**
   * 设持续目标、改它（目标的话、暂停与继续、预算），照 thread/goal/set 的部分更新，带着 origin: user。
   * 没有目标时要给 objective。harness 不会的报 unsupported。应答时对面已经受理，新的样子随后经 session.goal 到
   */
  'session.goal.set': {
    params: { deviceId: string; sessionId: string } & GoalChange
    result: Record<string, never>
  }
  /** 清掉持续目标 */
  'session.goal.clear': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /** 给会话改名 */
  'session.rename': {
    params: { deviceId: string; sessionId: string; title: string }
    result: Record<string, never>
  }
  /** 归档：从列表里收起来，内容还在设备上 */
  'session.archive': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /** 删除：设备上的会话记录一起删掉，找不回来。已归档的会话也能删 */
  'session.delete': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /** 把归档了的会话放回列表里 */
  'session.unarchive': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  // ---------- 整理侧栏 ----------
  // 这一组要对面有工作区这组方法（DeviceView.organizable）；没有时以 unsupported 结束。
  // 都是设备上的数据：别的连接看得到，别处改了这边也跟着变。
  /**
   * 置顶（pinned），放进一个组（{ sectionId }），或者从置顶、从它所在的组里拿出来（null）。
   * 会话所属的 harness 现在不可用时也能做。
   */
  'session.place': {
    params: { deviceId: string; sessionId: string; place: 'pinned' | { sectionId: string } | null }
    result: Record<string, never>
  }
  /** 把会话移到另一个工作区。只改它归在哪儿，工作目录和内容都不动 */
  'session.move': {
    params: { deviceId: string; sessionId: string; workspaceId: string }
    result: Record<string, never>
  }
  /** 加一个工作区：起个名字，指一个目录（设备上的完整路径）。只是记一条，不会去建目录 */
  'workspace.create': {
    params: { deviceId: string; name: string; root: string; color?: WireColor | null }
    result: { workspaceId: string }
  }
  /** 改工作区的名字、颜色。没给的不动；颜色给 null 是去掉 */
  'workspace.update': {
    params: {
      deviceId: string
      workspaceId: string
      name?: string
      color?: WireColor | null
      /** 置顶。置顶了就从组里拿出来 */
      pinned?: boolean
      /** 放进这个组（放进去就取消置顶），null 是从组里拿出来 */
      sectionId?: string | null
    }
    result: Record<string, never>
  }
  /** 调工作区的顺序：挪到 before 这个工作区前面；null 是挪到最后 */
  'workspace.move': {
    params: { deviceId: string; workspaceId: string; before: string | null }
    result: Record<string, never>
  }
  /** 删掉工作区这条记录。里面的会话、磁盘上的目录都不动，会话回到“没有工作区”那一组 */
  'workspace.delete': {
    params: { deviceId: string; workspaceId: string }
    result: Record<string, never>
  }
  /** 建一个组（协议里叫自定义分区）。建好是空的 */
  'section.create': { params: { deviceId: string; name: string }; result: { sectionId: string } }
  /** 给组改名 */
  'section.rename': {
    params: { deviceId: string; sectionId: string; name: string }
    result: Record<string, never>
  }
  /** 删掉一个组。里面的会话、工作区都放出来，回到原来的地方，不删它们 */
  'section.delete': {
    params: { deviceId: string; sectionId: string }
    result: Record<string, never>
  }
  /**
   * 加工作区时可以直接挑的目录：这台设备上还没归进任何工作区的会话的工作目录，最近用过的在前。
   * 客户端看不到设备上的文件系统，候选只能从已有的会话里来
   */
  'workspace.candidates': { params: { deviceId: string }; result: { roots: string[] } }
  /** 去取这台设备上已归档的会话。取到之后放在侧栏的数据里，之后有变化核心自己跟着改 */
  'device.loadArchived': { params: { deviceId: string }; result: Record<string, never> }
  /**
   * 在这台设备上发消息时能选的模型和权限预设。
   * 设备上不止一个 harness 时各是各的一份：harness 给的是会话所属的那个（新建时是选中的那个）
   */
  'device.composeOptions': {
    params: { deviceId: string; harness?: string }
    result: ComposeOptions
  }
  /**
   * 在这台设备上不带设置新建会话时，对面会用的模型、强度、权限档（新建页没选的那几项显示它，建会话时也发它）。
   * harness 同上；cwd 是要建在哪个工作目录下（项目里的配置也算），不知道给 null。不缓存，每次现问
   */
  'device.newSessionDefaults': {
    params: { deviceId: string; harness?: string; cwd: string | null }
    result: SessionDefaults
  }
  /**
   * 这个 harness 上能用的技能（输入框里打 `/` 时列出来的那些）。cwd 是在哪个工作目录下看：
   * 仓库里带的技能跟着目录走；给 null 就由对面按它自己的当前目录看。停用的技能不在里面。
   * harness 声明了带不了技能、或者对面不认识这个方法，以 unsupported 结束。
   * problems 是对面扫到了却没列出来的（文件读不出、元数据不合格、目录不在了），带着它的原话
   */
  'device.skills': {
    params: { deviceId: string; harness?: string; cwd: string | null }
    result: { skills: SkillOption[]; problems: SkillProblem[] }
  }
  /** 打断正在进行的回合 */
  'session.interrupt': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /**
   * 把一条排着队的消息现在就插进正在进行的回合里（引导）。
   * 对面不支持或者没插成时，消息留在队列里，出错原因交给界面显示。
   */
  'session.steer': {
    params: { deviceId: string; sessionId: string; messageId: string }
    result: Record<string, never>
  }
  /** 把一条排着队的消息拿掉 */
  'session.unqueue': {
    params: { deviceId: string; sessionId: string; messageId: string }
    result: Record<string, never>
  }
  /**
   * 答复一个等人处理的请求。审批给 optionId（请求自带的选项之一）；
   * 提问给 answers（题目标识 → 选中或填写的答案）。
   * note 是附在这个决定上的一句说明，只有选项声明了能带说明（ApprovalOption.note）时才收。
   */
  'session.respond': {
    params: {
      deviceId: string
      sessionId: string
      requestId: string
      optionId?: string
      note?: string
      answers?: Record<string, string[]>
      /** 表单各栏填的值，按栏的标识 */
      values?: Record<string, unknown>
    }
    result: Record<string, never>
  }
  /** 立刻重连一台设备。正在等重连或已经失败时才有效果 */
  'device.reconnect': { params: { deviceId: string }; result: Record<string, never> }
  /**
   * 远程设备服务的一键升级（界面上用户确认过才发）。start：在那台机器上装应用的这一版、空闲时换上
   * （装着的已经不旧时只换）；retry：等空闲时现在再请一次；force：立即换上，进行中的事会被打断。
   * 立刻返回，进度和结果在设备显示数据的 remoteUpgrade 里；做不了（本机设备、认不出安装方式、上一步没做完）是 rejected
   */
  'device.upgradeService': {
    params: { deviceId: string; mode: 'start' | 'retry' | 'force' }
    result: Record<string, never>
  }
  /** 手动刷新一台设备的会话目录 */
  'device.refresh': { params: { deviceId: string }; result: Record<string, never> }
  /**
   * 加一台远程设备，加完就开始连。名字留空就用别名或主机名，线色不给就挑一个没用过的。
   * 这里没有密码：登录交给系统的 ssh 和密钥代理。
   */
  'device.add': {
    params: { name: string; target: RemoteTarget; wire?: WireColor }
    result: { deviceId: string }
  }
  /**
   * 改一台设备的显示名、线色、怎么连。本机设备只能改线色。
   * 改了怎么连，就按新的配置重新连，侧栏清空重来。
   */
  'device.update': {
    params: { deviceId: string; name?: string; wire?: WireColor; target?: RemoteTarget }
    result: Record<string, never>
  }
  /** 去掉一台远程设备。只是不再连它，那台机器上的东西一样不动 */
  'device.remove': { params: { deviceId: string }; result: Record<string, never> }
  /**
   * 设备设置页上的两个开关：这台设备上的会话能不能用这台桌面端的内置浏览器、Computer Use。
   * 只改给了的那一项。存在桌面端；建会话时关着的不挂那组工具，调用时再查一次，已经建好的会话下一次调用就按新的来。
   * 带 harness 时只改这台设备上这个 harness 的（machine 不分 harness，带 harness 时不收）
   */
  'device.tools.set': {
    params: {
      deviceId: string
      harness?: string
      browser?: boolean
      computer?: boolean
      machine?: boolean
    }
    result: Record<string, never>
  }
  /**
   * 远程设备“操作这台电脑”的审批方式和访问范围（08 号 3.2、3.3）。只改给了的那几项；
   * 开关本身走 device.tools.set。本机设备以 invalid 结束
   */
  'device.machine.set': {
    params: {
      deviceId: string
      approval?: MachineApproval
      access?: { mode: MachineAccessMode; custom?: string[] }
    }
    result: Record<string, never>
  }
  /** 答全局待处理里的一张卡片。已经答过、过期了以 notFound 结束 */
  'machine.answer': {
    params: { pendingId: string; optionId: string; note?: string }
    result: Record<string, never>
  }
  /** 结束顶栏弹层里的一个进程 */
  'machine.process.kill': { params: { processId: string }; result: Record<string, never> }
  /** 全部停：结束远程会话在这台电脑上起的所有进程、撤掉所有待处理卡片。给了 deviceId 只停这台设备的 */
  'machine.stopAll': { params: { deviceId?: string }; result: Record<string, never> }
  /** 一台设备最近的操作记录，新的在前 */
  'machine.log': { params: { deviceId: string }; result: { entries: MachineLogEntry[] } }
  'machine.log.clear': { params: { deviceId: string }; result: Record<string, never> }
  /**
   * 改设备服务的设置。一次写入要么全部生效，要么一项都不写；expectedVersion 是界面看到的那个版本号。
   * 别处先改过了（版本号对不上）就以 conflict 结束：什么都没写，最新的值已经经订阅到了界面，不会悄悄覆盖。
   * 哪一项的值不合规矩以 invalid 结束，错误里说是哪一项。
   */
  'device.settings.write': {
    params: { deviceId: string; expectedVersion: number; edits: SettingEditView[] }
    result: SettingsWriteResult
  }
  /**
   * 重启一个 harness，同时把它待重启的设置用上。等到它有了结果才应答，可能要一分多钟。
   * 它有回合在跑时以 busy 结束，什么都没做；force 为真表示用户说了照做，回合会被打断。
   */
  'device.harness.restart': {
    params: { deviceId: string; harness: string; force?: boolean }
    result: HarnessRestartResult
  }
  /** 运行诊断。harness 不给就全查；要等各项检查跑完，可能要一两分钟 */
  'device.diagnostics.run': {
    params: { deviceId: string; harness?: string }
    result: DiagnosticsView
  }
  /** 读一份日志的末尾 */
  'device.logs.read': {
    params: { deviceId: string; source: LogSource; harness?: string; maxBytes?: number }
    result: LogTailView
  }
  /** 取给官方 Codex 桌面端用的 ssh 配置片段 */
  'device.sshConfig.read': { params: { deviceId: string }; result: SshConfigView }
  /**
   * 在这台设备上开一个终端，挂在一个工作区上（workspaceId 给 null 是设备主目录的那一组）。
   * 以对面用户的登录 shell 启动；工作目录按“cwd → 工作区的根 → 设备的主目录”依次试，在对面试。
   * 应答时进程已经起来。到了设备上同时能开的上限以 rejected 结束
   */
  'terminal.open': {
    params: {
      deviceId: string
      workspaceId: string | null
      cwd?: string | null
      rows: number
      cols: number
    }
    result: { terminalId: string }
  }
  /** 往终端里写：data 是 base64 的字节（键盘输入、粘贴的内容）。不等对面应答，按发的先后写进去 */
  'terminal.write': {
    params: { deviceId: string; terminalId: string; data: string }
    result: Record<string, never>
  }
  /** 终端控件的行列数变了。连着发几次只有最后一次算数 */
  'terminal.resize': {
    params: { deviceId: string; terminalId: string; rows: number; cols: number }
    result: Record<string, never>
  }
  /** 让里面的全屏程序把画面重画一遍：补回来的输出不完整的时候用 */
  'terminal.redraw': {
    params: { deviceId: string; terminalId: string }
    result: Record<string, never>
  }
  /** 给终端起个名字。留空就是用回默认的名字 */
  'terminal.rename': {
    params: { deviceId: string; terminalId: string; title: string }
    result: Record<string, never>
  }
  /**
   * 关掉一个标签。end：结束里面的进程，设备上不留记录；
   * leave：进程留在设备上接着跑，只是这边不看了（只有属于设备的终端可以），之后能用 terminal.show 接回来
   */
  'terminal.close': {
    params: { deviceId: string; terminalId: string; mode: 'end' | 'leave' }
    result: Record<string, never>
  }
  /** 把一个留在设备上的终端接回来，开成标签 */
  'terminal.show': {
    params: { deviceId: string; terminalId: string }
    result: Record<string, never>
  }
  /** 在同一个标签里重开：进程已经退出，或者断线没了的时候 */
  'terminal.restart': {
    params: { deviceId: string; terminalId: string; rows: number; cols: number }
    result: Record<string, never>
  }
  /**
   * 界面回报：这个终端的输出，这次订阅（viewer）已经处理到 offset 了。
   * 核心按它决定还给不给这个界面发：处理不过来的时候不往它那里堆，略过的地方会有记号
   */
  'terminal.ack': {
    params: { deviceId: string; terminalId: string; viewer: number; epoch: number; offset: number }
    result: Record<string, never>
  }
  // ---------- 文件面板 ----------
  // root 是工作区的根（不属于工作区的会话是它的工作目录），path 是它里面的完整路径；两样都是对面机器上的路径。
  // 核心自己核对：根得是这台设备上认得的，路径得在根之内，不然以 rejected 结束。对面不会就以 unsupported 结束。
  /**
   * 列一层目录：目录在前，隐藏的也在里面。核心留一小会儿缓存，同时要同一层的只问对面一次；
   * fresh 为真是不用缓存、重新去取
   */
  'files.list': {
    params: { deviceId: string; root: string; path: string; fresh?: boolean }
    result: DirectoryView
  }
  /** 读一个文件。太大的、不是文字的只说是哪一种，不给内容；路径是目录、文件不在了也各有一种结果，不算出错 */
  'files.read': {
    params: { deviceId: string; root: string; path: string }
    result: FileContent
  }
  /**
   * 在根下面模糊找文件，最多几十条。同一个根上后来的一次会让前一次以 cancelled 结束；
   * 界面自己取消（用户接着打字了）也是 cancelled
   */
  'files.search': {
    params: { deviceId: string; root: string; query: string }
    result: FileSearchView
  }
  /**
   * 各层目录、各个文件真的向对面要过几次（走缓存的、搭别人便车的不算）。键是完整路径。
   * 没有界面用它，是给验收量“每层只请求一次”用的
   */
  'files.requests': {
    params: { deviceId: string }
    result: { lists: Record<string, number>; reads: Record<string, number> }
  }
  // ---------- 差异面板 ----------
  // root 和文件面板的一样；path 是相对于根的路径（概况里给的那种）。核心自己核对路径落在根里面。
  // 数据来自设备上的 git：那里不是仓库、没装 git、对面不会起进程时，订阅的概况里会说明，这几条命令没有东西可给。
  /**
   * 全部文件的差异，一次取回来（文件不多、改动不大的时候界面连着显示用）。
   * 合起来太大就不带内容、truncated 为真，界面改成一次只看一个文件
   */
  'diff.files': {
    params: { deviceId: string; root: string; scope: DiffScope; sessionId?: string | null }
    result: DiffBundle
  }
  /** 一个文件的差异。full 为真：带上整个文件当上下文（展开上下文用） */
  'diff.file': {
    params: {
      deviceId: string
      root: string
      scope: DiffScope
      sessionId?: string | null
      path: string
      full?: boolean
    }
    result: FileDiff
  }
  /** 重新取这个根的概况。应答时已经取完，新的概况已经经订阅发出去了 */
  'diff.refresh': { params: { deviceId: string; root: string }; result: Record<string, never> }
  /** 把这几个文件现在的样子暂存起来（新加的、改了的、删了的都算）。应答时概况已经更新 */
  'diff.stage': {
    params: { deviceId: string; root: string; paths: string[] }
    result: Record<string, never>
  }
  /** 取消暂存：暂存区里的这几个文件回到上一次提交的样子，工作区里的内容不动 */
  'diff.unstage': {
    params: { deviceId: string; root: string; paths: string[] }
    result: Record<string, never>
  }
  /**
   * 还原一个文件：它在这个范围里的改动丢掉，找不回来（没跟踪的、新加的文件会被删掉）。
   * expect 是用户确认时界面上显示的状态：文件在这期间变成了另一种情形就不动它，以 conflict 结束。
   * 已暂存的范围不能还原（先取消暂存）；合并冲突着的文件不在这里处理，以 rejected 结束
   */
  'diff.discard': {
    params: { deviceId: string; root: string; scope: DiffScope; path: string; expect: DiffStatus }
    result: Record<string, never>
  }
  /** 差异模块在设备上起过多少次 git、概况取过多少遍。没有界面用它，是给验收量的 */
  'diff.requests': { params: { deviceId: string }; result: DiffRequests }
  // ---------- 定时任务 ----------
  // 都要设备列了 deviceTasks（TasksView.available），不然以 unsupported 结束；没连上以 offline 结束。
  // 成了之后核心自己先把新的样子经 tasks 主题发出去，不等通知（通知再来是幂等的）。
  // 设备回的错误换成：没有这个任务 notFound；字段不对 invalid（key 是哪个字段，比如 schedule.time、name）；
  // 任务数到了上限 rejected（text 说明）
  /** 建一个任务 */
  'tasks.create': { params: { deviceId: string; task: TaskDraft }; result: { task: TaskView } }
  /**
   * 改一个任务。revision 是界面开始改的时候看到的那一版：别处先改过了以 conflict 结束，什么都没写，
   * 最新的样子已经经订阅到了界面
   */
  'tasks.update': {
    params: { deviceId: string; taskId: string; revision: number; patch: TaskPatch }
    result: { task: TaskView }
  }
  /** 暂停（paused 为真）或者继续。不用带版本：按核心手里最新的那一版改，撞上别处的改动就再试一次 */
  'tasks.pause': {
    params: { deviceId: string; taskId: string; paused: boolean }
    result: { task: TaskView }
  }
  /** 删掉任务和它的运行记录。正在跑的那一次不打断 */
  'tasks.delete': { params: { deviceId: string; taskId: string }; result: Record<string, never> }
  /** 立即运行一次，不影响日程。已经有一次在跑或在排队就不另起，回的是那一次（deduplicated 为真） */
  'tasks.runNow': {
    params: { deviceId: string; taskId: string }
    result: { run: TaskRunView; deduplicated: boolean }
  }
  /**
   * 运行记录的一页，新的在前。taskId 给 null 是全部任务的；cursor 是上一页的 nextCursor。
   * 数据副本的 openTaskRuns、moreTaskRuns 用它，界面一般不直接调
   */
  'tasks.runs': {
    params: { deviceId: string; taskId: string | null; cursor?: string | null; limit?: number }
    result: { runs: TaskRunView[]; nextCursor: string | null }
  }
  /** 标成看过了。给 runIds 只标这几条；只给 taskId 标这个任务的全部 */
  'tasks.markRead': {
    params: { deviceId: string; taskId?: string; runIds?: string[] }
    result: Record<string, never>
  }
  // ---------- 扫码绑定手机 ----------
  // 都要设备列了 devicePairing，不然以 unsupported 结束；没连上以 offline 结束。失败的 key 见 PairingStartFailure。
  /**
   * 出码：设备上建配对、核对主机钥匙、自检，都过了才回。配对的状态变化经 pairing.status 回来。
   * address 是手机要连的地址（表单里现在的），不给就用记住的或原配置；mode 不给就按这个地址认（pairModeOf）
   */
  'pairing.start': {
    params: { deviceId: string; address?: PairingTarget; mode?: PairMode }
    result: { pairing: PairingView }
  }
  /** 手机要连的这个地址该用哪种方式出码（读横幅，读不到时看设备自报）。表单里改了主机、端口时问 */
  'pairing.detect': {
    params: { deviceId: string; host: string; port: number }
    result: { mode: PairMode }
  }
  /** 关掉对话框、换新码前：作废这个配对 */
  'pairing.cancel': { params: { deviceId: string; pairId: string }; result: Record<string, never> }
  /** 允许或拒绝正在登记的手机 */
  'pairing.decide': {
    params: { deviceId: string; pairId: string; allow: boolean }
    result: { status: PairStatus }
  }
  /** 当前状态（对话框打开时先拿一次，之后跟通知） */
  'pairing.status': { params: { deviceId: string; pairId: string }; result: { status: PairStatus } }
  /** 记下这台设备给手机用的地址；null 是忘掉、回到原配置 */
  'pairing.rememberAddress': {
    params: { deviceId: string; address: PairingAddress | null }
    result: Record<string, never>
  }
  /** 这台设备上已绑定的手机 */
  'pairing.phones': { params: { deviceId: string }; result: { phones: PairPhone[] } }
  /** 撤掉一部手机的钥匙行 */
  'pairing.revoke': { params: { deviceId: string; phoneId: string }; result: Record<string, never> }
  // ---------- 会话树 ----------
  // 这一组要设备服务声明了会话树（DeviceView.sessionTree），没有时以 unsupported 结束（session.agents 除外）。
  /**
   * 在 parentId 这个会话下面派一个 Litch 子会话（设备上的 litch/session/start）。harness 不给是父会话的，
   * kind 为 fork 时只能和父会话同一个 harness；workspaceId、cwd 不给跟父会话一样。
   * 应答时子会话已经建好、第一段话已经发给它；侧栏里它嵌在父会话下面
   */
  'session.spawn': {
    params: {
      deviceId: string
      parentId: string
      harness?: string
      model?: string
      effort?: string
      workspaceId?: string
      cwd?: string
      kind: LineageKind
      title: string
      prompt: string
      /** 任务之前的背景（全新开始时才用）。可以不给 */
      background?: string
      wakeParent: boolean
      /** 子会话的沙箱档（审批策略跟着配）。不给是跟父会话一样；给了也收紧到不宽于父会话 */
      sandbox?: SandboxLevel
    }
    result: { sessionId: string }
  }
  /** 把一个 Litch 子会话脱离成独立会话：去掉父子关系，会话本身不动 */
  'session.detach': {
    params: { deviceId: string; sessionId: string }
    result: Record<string, never>
  }
  /**
   * 用户点了提案上的“开始”（或者“改了再开始”，带着改过的那几项）：起这个子会话。应答时子会话已经建好
   */
  'session.proposal.accept': {
    params: {
      deviceId: string
      sessionId: string
      proposalId: string
      overrides?: ProposalOverrides
    }
    result: { sessionId: string }
  }
  /** 用户点了提案上的“不要” */
  'session.proposal.dismiss': {
    params: { deviceId: string; sessionId: string; proposalId: string }
    result: Record<string, never>
  }
  /**
   * 用户在 offer 卡上选了“新会话”（session）或“在这里做”（here）。选了新会话不在这里起子会话：
   * 等着的那次 start 调用拿到答复，模型接着用 accept 补上简报，设备进程才起
   */
  'session.proposal.answer': {
    params: { deviceId: string; sessionId: string; proposalId: string; choice: OfferChoice }
    result: Record<string, never>
  }
  /**
   * 用户点了普通提案卡上的“在这里做”：提案记 here，设备进程往这个会话发一条用户消息（lead 加标题和任务），
   * 会话正在跑回合时排到回合结束后发（核心的输入队列，看得见）。lead 是界面语言的“在这里做：”
   */
  'session.proposal.here': {
    params: { deviceId: string; sessionId: string; proposalId: string; lead?: string }
    result: Record<string, never>
  }
  /**
   * 这个会话下面引擎自己的子代理线程（thread/list 带 parentThreadId，只要直接的子女）。
   * 不缓存，每次现问；对面不会按父会话查的以 unsupported 结束
   */
  'session.agents': {
    params: { deviceId: string; sessionId: string }
    result: { agents: AgentThreadView[] }
  }
  // ---------- 工作树 ----------
  // 都要设备列了 worktrees，不然以 unsupported 结束；没连上以 offline 结束。
  /** 一个目录所在仓库的分支（新建页“从哪切”）。目录不在 git 仓库里时 branches 是 null */
  'worktree.branches': {
    params: { deviceId: string; cwd: string }
    result: { branches: WorktreeBranchesView | null }
  }
  /**
   * 删一个工作树的目录：有改动时 discard 为真直接丢，否则先做快照（能恢复）。分支留着，withBranch 为真才删
   *（连快照和记录一起删）。结果同时进 worktrees 主题
   */
  'worktree.remove': {
    params: { deviceId: string; id: string; discard?: boolean; withBranch?: boolean }
    result: { worktree: WorktreeView }
  }
  /** 把删了目录的工作树建回原路径（有快照的连改动一起放回）。原路径被占、分支和快照都没了以 rejected 结束 */
  'worktree.restore': {
    params: { deviceId: string; id: string }
    result: { worktree: WorktreeView }
  }
  // ---------- 给设备装 harness ----------
  // 都要设备列了 harnessInstall，不然以 unsupported 结束；没连上以 offline 结束。
  /** 问各 harness 的版本。latest：现查最新版（设备联网，五秒超时）。问到的同时进 install 主题 */
  'install.versions': {
    params: { deviceId: string; latest?: boolean }
    result: { harnesses: HarnessVersionView[] }
  }
  /** 开始装一个 harness：验证版或最新版。应答只带任务号，进度看 install 主题。同一台设备上已有任务在跑时设备拒绝 */
  'install.start': {
    params: { deviceId: string; harness: string; version: HarnessInstallTarget }
    result: { job: string }
  }
  // ---------- harness 详情设置 ----------
  // 都要设备和这个 harness 都声明了 harnessConfig，不然以 unsupported 结束；没连上以 offline 结束。
  // 带版本的写入，版本对不上以 conflict 结束：什么都没写，核心已经把那一块重读了、经订阅到了界面。
  // 对面回的错误换成：值不对 invalid（key 是哪一项）；被锁住 rejected；没有这一项 notFound；
  // 登录没成、harness 没装或没在跑都是 remote（said 是对面给的话）
  /** 写若干配置项，全有或全无 */
  'harnessConfig.write': {
    params: {
      deviceId: string
      harness: string
      edits: HcEdit[]
      expectedVersion: string
    }
    result: { overriddenKeys: string[]; restartRequired: boolean }
  }
  /** 执行配置里列着的一个动作（清空记忆之类）。确认由界面先问 */
  'harnessConfig.action': {
    params: { deviceId: string; harness: string; actionId: string }
    result: Record<string, never>
  }
  /** 手动重读。part 不给是全部 */
  'harnessConfig.reload': {
    params: { deviceId: string; harness: string; part?: HcPart }
    result: Record<string, never>
  }
  /** 新增或改一个自定义 provider。密钥字段不给表示不改 */
  'harnessConfig.providers.upsert': {
    params: {
      deviceId: string
      harness: string
      providerId: string
      templateId: string
      definition: Record<string, HcValue>
      expectedVersion: string
    }
    result: { restartRequired: boolean }
  }
  'harnessConfig.providers.remove': {
    params: { deviceId: string; harness: string; providerId: string }
    result: { restartRequired: boolean }
  }
  /** 切换当前在用的 provider（providers 的 switchable 为真时才有） */
  'harnessConfig.providers.activate': {
    params: { deviceId: string; harness: string; providerId: string; expectedVersion: string }
    result: { restartRequired: boolean }
  }
  /**
   * 开始一次登录或设置 API key。应答时第一步已经在订阅里了（attempts）。
   * env 方式不走这里，走 harnessConfig.env.set
   */
  'harnessConfig.auth.start': {
    params: {
      deviceId: string
      harness: string
      providerId: string
      methodId: string
      inputs?: Record<string, string>
    }
    result: { attemptId: string }
  }
  /** 交上一步要的东西（粘贴的授权码、表单）。下一步经订阅到 */
  'harnessConfig.auth.continue': {
    params: { deviceId: string; harness: string; attemptId: string; inputs: Record<string, string> }
    result: Record<string, never>
  }
  /** 取消进行中的登录 */
  'harnessConfig.auth.cancel': {
    params: { deviceId: string; harness: string; attemptId: string }
    result: Record<string, never>
  }
  /** 结束了的登录从订阅里拿掉（界面上点了“知道了”） */
  'harnessConfig.auth.dismiss': {
    params: { deviceId: string; harness: string; attemptId: string }
    result: Record<string, never>
  }
  /** 登出、清掉这个 provider 的凭据 */
  'harnessConfig.auth.logout': {
    params: { deviceId: string; harness: string; providerId: string }
    result: Record<string, never>
  }
  /**
   * env 方式：把一个只认环境变量的密钥写进设备设置里这个 harness 的环境变量表（deviceSettings 的 env 类设置项，
   * 当作密钥存），value 给 null 是去掉。harness 要重启才读得到：restartRequired 为真时界面提示重启
   */
  'harnessConfig.env.set': {
    params: { deviceId: string; harness: string; name: string; value: string | null }
    result: { restartRequired: boolean }
  }
  /** 新增或整条替换一个 MCP 服务。改名时给 previousName */
  'harnessConfig.mcp.upsert': {
    params: {
      deviceId: string
      harness: string
      previousName?: string
      server: HcMcpServer
      expectedVersion: string
    }
    result: { restartRequired: boolean }
  }
  'harnessConfig.mcp.remove': {
    params: { deviceId: string; harness: string; name: string; expectedVersion: string }
    result: { restartRequired: boolean }
  }
  /** MCP 服务的 OAuth 登录。进展和 provider 的登录一样在 attempts 里 */
  'harnessConfig.mcp.login': {
    params: { deviceId: string; harness: string; name: string }
    result: { attemptId: string }
  }
  /** 整个写进这个 harness 的用户级指令文件。expectedHash 是界面开始改时看到的 */
  'harnessConfig.instructions.write': {
    params: { deviceId: string; harness: string; content: string; expectedHash: string }
    result: { hash: string }
  }
  /**
   * 整份写模型清单（config 的 modelCatalog 为真的 harness 才有）。顺序就是模型选择里的顺序；
   * entries 给 null 是不用自定义清单、回到 harness 自带的模型目录，空数组以 invalid 结束。
   * restartRequired 为真时订阅里的 restartRequired 也已经是真的，界面照“需要重启”提示
   */
  'harnessConfig.models.write': {
    params: {
      deviceId: string
      harness: string
      entries: HcModelEntry[] | null
      expectedVersion: string
    }
    result: { restartRequired: boolean }
  }
  /** 设备上各 harness 的指令文件一览，和现在是不是统一模式。不缓存，每次现读 */
  'instructions.overview': {
    params: { deviceId: string }
    result: InstructionsOverview
  }
  /**
   * 统一模式：把 content 写进 harness 那一份，其余读得到的各份备份后改成指向它的软链。
   * 应答时各 harness 的指令文件都已经重读、经订阅到了界面
   */
  'instructions.unify': {
    params: { deviceId: string; harness: string; content: string }
    result: { results: InstructionsLinkResult[] }
  }
  /** 退出统一模式：指向那份真文件的软链换回各自的副本 */
  'instructions.separate': {
    params: { deviceId: string }
    result: { separated: string[] }
  }
  // ---------- 配置 Litch（litch_config） ----------
  /** 界面做完了 config 主题里的一件事。ok 为假时 reason 是给模型看的一句（英文） */
  'config.reply': {
    params: { id: string; ok: boolean; data?: unknown; reason?: string }
    result: Record<string, never>
  }
  /** 确认卡上点了允许或拒绝 */
  'config.confirm': { params: { id: string; allow: boolean }; result: Record<string, never> }
  /**
   * 直接跑一次 litch config（和本机 harness 里的命令行走同一个执行器，放宽安全的那几项照样弹确认卡）。
   * 给验收和调试用；结果是给模型读的那段字
   */
  'config.run': {
    params: { argv: string[]; json?: boolean; lang?: 'zh-CN' | 'en' | null }
    result: { ok: boolean; text: string }
  }
  /** 用户的 ssh 配置里有哪些主机 */
  'remote.discover': { params: Record<string, never>; result: { hosts: DiscoveredHost[] } }
  /** 添加之前先连过去看一眼对面有什么。不启动任何东西 */
  'remote.check': { params: { target: RemoteTarget }; result: RemoteCheck }
}

export type CommandName = keyof Commands

// ---------- 错误 ----------

export interface ChannelErrorShape {
  /** 稳定的错误码，界面按它决定怎么提示 */
  code:
    | 'cancelled'
    | 'unknownCommand'
    | 'unknownTopic'
    | 'notFound'
    | 'closed'
    | 'internal'
    /** 设备没连上，或者请求途中断了 */
    | 'offline'
    /** 设备那头报了错。message 是它给的原因 */
    | 'remote'
    | 'timeout'
    /** 这件事现在做不了：会话是只读的、没有回合可打断、请求已经不在了 */
    | 'rejected'
    /** 对面不会做这件事（它不认识这个方法）。界面把入口停掉 */
    | 'unsupported'
    /** 设置在别处被改过了，这次什么都没写。最新的值已经经订阅到了界面 */
    | 'conflict'
    /** 那个 harness 有回合在跑，没有去打断它 */
    | 'busy'
    /** 写入的值不合规矩。key 是哪一项 */
    | 'invalid'
  message: string
  /**
   * 核心说得出这是哪一句的时候给：界面按当前语言说它，不显示 message。
   * 没有的时候 message 是对面的原话，或者核心留给日志的一句
   */
  text?: Phrase
  /** 设备服务把原因的两种语言版本都给了的时候带上：界面按当前语言说它，不显示 message */
  said?: Bilingual
  /** invalid：哪一项设置 */
  key?: string
}

/** 错误上除了错误码和原因之外可以带的东西 */
export type ChannelErrorExtra = Pick<ChannelErrorShape, 'said' | 'key'>

export class ChannelError extends Error {
  readonly code: ChannelErrorShape['code']
  readonly text: Phrase | undefined
  readonly said: Bilingual | undefined
  readonly key: string | undefined

  constructor(
    code: ChannelErrorShape['code'],
    message: string,
    text?: Phrase,
    extra: ChannelErrorExtra = {},
  ) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    this.text = text
    this.said = extra.said
    this.key = extra.key
  }

  toShape(): ChannelErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.text ? { text: this.text } : {}),
      ...(this.said ? { said: this.said } : {}),
      ...(this.key === undefined ? {} : { key: this.key }),
    }
  }
}

export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error
  return new ChannelError('internal', error instanceof Error ? error.message : String(error))
}

// ---------- 线上消息 ----------
// 两端在各自的范围内分配编号；命令和订阅各用一套编号。

export type ClientMessage =
  | { t: 'cmd'; id: number; name: string; params: unknown }
  | { t: 'cancel'; id: number }
  | { t: 'sub'; id: number; topic: Topic }
  | { t: 'unsub'; id: number }

export type ServerMessage =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: ChannelErrorShape }
  | { t: 'snap'; id: number; data: unknown }
  | { t: 'delta'; id: number; ops: unknown[] }
  | { t: 'subError'; id: number; error: ChannelErrorShape }

// ---------- 平台注入 ----------
// 核心不直接碰任何平台接口。端口、定时器、取消信号都是接口，由外壳给实现。

/** 一条双向消息端口。桌面上是 Electron 的消息端口，浏览器里是 MessagePort */
export interface Port {
  /** 发出的那一刻取值：之后调用的一方再改这个对象，不影响已经发出去的 */
  post(message: unknown): void
  /** 只调用一次 */
  listen(handler: (message: unknown) => void): void
  close(): void
}

export interface Clock {
  now(): number
  /** 返回取消函数 */
  setTimer(callback: () => void, delayMs: number): () => void
}

/** 结构上与标准的 AbortSignal 兼容，可以直接传一个 AbortSignal 进来 */
export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}
