// 一个 harness（引擎）的结构化声明：能做什么、有哪些权限预设、认识我们的哪些扩展；
// 以及“拒绝时附说明”这项扩展（扩展名 declineWithNote）里和线上形状有关的名字。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/runtime-info.json 和
// decline-with-note.json。规矩：扩展只增不改，扩展内容只发给声明过的连接，没改过的官方桌面端要始终能连。
//
// 这个文件不引用别的文件：引擎（packages/claude、pi、dsh）、设备进程和客户端核心都直接引用它。
//
// 声明出现在引擎自己的 `runtime/info` 应答里（下面的 HarnessDeclaration 那几个字段，和原有的字段并排）。
// 客户端照它画界面，所以每一位说的都是“现在这个引擎经适配器实际做得到”，不是“协议里有这个方法”。
// 原生 codex 自己报不了：聚合面上它的声明由设备进程替它整理（packages/device/src/native-codex.mts），形状一样。
// 引擎没报某个字段（旧版的适配器、拿不准的运行方式）时，客户端退回“先调用、失败就记住并降级”。

/** 给人看的字，中文和英文各一份，客户端按自己的语言取 */
export interface CapabilityText {
  'zh-CN': string
  en: string
}

/** 协议里用户输入的种类，就是 `UserInput` 的 `type` */
export type HarnessInputType = 'text' | 'image' | 'localImage' | 'skill' | 'mention'

/**
 * 引擎会向客户端发起的审批请求的种类，各对应协议里一种服务端请求：
 * - command：`item/commandExecution/requestApproval`
 * - fileChange：`item/fileChange/requestApproval`
 * - permissions：`item/permissions/requestApproval`（模型申请追加权限）
 */
export type HarnessApprovalKind = 'command' | 'fileChange' | 'permissions'

/**
 * 审批覆盖不到的范围。以后还会加，客户端遇到不认识的值照样显示成“有覆盖不到的地方”。
 * - subagents：子代理里的操作不会来问用户
 */
export type HarnessApprovalGap = 'subagents'

/**
 * 助手消息的“过程说明”和“最终回答”（`agentMessage.phase`）什么时候分得清：
 * - onStart：消息一开始（`item/started`）就带着准的阶段值
 * - onCompleted：消息结束（`item/completed`）时才准；开始时的阶段值不能信
 * - none：不区分
 * 客户端只在 onStart 下做“最终回答一开始就收起活动区”，也只在 onStart 下采信开始时的阶段值。
 */
export type AgentMessagePhaseSupport = 'onStart' | 'onCompleted' | 'none'

/** 能力位。每一位都是必填的；以后新加的位是可选的，没有就当“不知道” */
export interface HarnessFeatures {
  /** 回合进行中追加输入（`turn/steer`） */
  steer: boolean
  /** 打断回合（`turn/interrupt`） */
  interrupt: boolean
  /** 手动压缩上下文（`thread/compact/start`） */
  compact: boolean
  /** 分叉（`thread/fork`），可以用 `lastTurnId` 或 `beforeTurnId` 指定从哪一轮分 */
  fork: boolean
  /** 回退：把会话退回到某一轮之前 */
  revert: {
    /** 按回合标识：`thread/revert` 带 `beforeTurnId` */
    byTurnId: boolean
    /** 按个数：`thread/rollback` 带 `numTurns`（上游已删除的旧方法，适配器还留着） */
    byCount: boolean
    /** 回退时会不会把那几轮改过的文件也恢复原样 */
    restoresFiles: boolean
  }
  /** 设备侧的消息队列（`thread/queue/*`）：排队的消息存在设备上，客户端断开也不丢 */
  queue: boolean
  /** 发不发本回合的差异（`turn/diff/updated`）。靠 git 算的引擎只在工作目录是 git 仓库时才有 */
  turnDiff: boolean
  /** 命令还在跑的时候输出是不是一段一段地来（`item/commandExecution/outputDelta`）；不是的话命令结束时一次给全 */
  commandOutputDelta: boolean
  approvals: {
    /** 会发起哪几类审批。空数组表示这个引擎从不来问 */
    kinds: HarnessApprovalKind[]
    /** 审批覆盖不到的范围 */
    uncovered: HarnessApprovalGap[]
  }
  /** 向用户提问（`item/tool/requestUserInput`） */
  userInput: boolean
  /** 转发 MCP 服务的征询（`mcpServer/elicitation/request`） */
  mcpElicitation: boolean
  /** 发不发待办进度（`turn/plan/updated`） */
  planUpdates: boolean
  /** `turn/start` 接受的输入种类 */
  inputTypes: HarnessInputType[]
  /** `turn/steer` 接受的输入种类。比 `inputTypes` 少的那几种在引导时带不过去 */
  steerInputTypes: HarnessInputType[]
  /** 归档与恢复（`thread/archive`、`thread/unarchive`） */
  archive: boolean
  /** 删除会话（`thread/delete`） */
  delete: boolean
  /** 会话改名（`thread/name/set`） */
  rename: boolean
  agentMessagePhase: AgentMessagePhaseSupport
}

export type PermissionRisk = 'low' | 'medium' | 'high'

/**
 * 一个权限预设。标识就是协议里原有的权限档标识：客户端选了之后放在 `thread/start`、`turn/start`、
 * `thread/settings/update` 的 `permissions` 里发回来，别的（审批策略、沙箱）不用带，
 * 到底层设置的映射留在引擎里。会话现在用的是哪一个，看会话设置里的 `activePermissionProfile`。
 */
export interface PermissionPreset {
  id: string
  title: CapabilityText
  /** 一句话说明 */
  description: CapabilityText
  risk: PermissionRisk
  /** 选它之前要不要再问用户一遍 */
  requiresConfirmation: boolean
  /** 会话建好之后还能不能换到这一档（两个回合之间） */
  switchInSession: boolean
  /** 回合进行中换到这一档，对正在进行的回合起不起作用。false 时要等下一个回合 */
  switchDuringTurn: boolean
}

/** 引擎在自己的 `runtime/info` 应答里加的字段。聚合面把它们原样带到每个 harness 上 */
export interface HarnessDeclaration {
  /** 显示名，例如 Claude Code */
  displayName?: string
  /** 两个字母的徽标，例如 CC */
  badge?: string
  /** 这个引擎支持的我们自己的扩展（扩展名见 device.mts 的 EXTENSION） */
  extensions?: string[]
  features?: HarnessFeatures
  /** 顺序就是界面上从上到下的顺序，限制最多的在前 */
  permissionPresets?: PermissionPreset[]
}

// ---------- 拒绝时附说明（扩展名 declineWithNote） ----------

/**
 * 审批请求的 `availableDecisions` 里的名字：列了它表示对面收“拒绝并附说明”，说明会交给模型。
 * 只出现在握手时声明了 declineWithNote 的连接上。应答的形状是 extensions.mts 的 DeclineWithNoteDecision
 */
export const DECLINE_WITH_NOTE_DECISION = 'declineWithNote'

/** 说明最多这么多个字符，超出的部分引擎不会交给模型 */
export const DECLINE_NOTE_MAX_LENGTH = 4000

/** 声明了 declineWithNote 的连接上，引擎会列在 `availableDecisions` 里的决定 */
export type ListedApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | typeof DECLINE_WITH_NOTE_DECISION

/**
 * 文件改动的审批请求上我们加的字段。标准协议里这种请求不带决定列表（按钮是固定的四个）；
 * 声明了 declineWithNote 的连接上引擎带上它，只列自己真的区分对待的那几种。
 * 原生 codex 的这种请求由聚合面的设备进程补上固定的四个（不含 declineWithNote：它收不了说明）
 */
export interface FileChangeApprovalDecisions {
  availableDecisions?: ListedApprovalDecision[]
}
