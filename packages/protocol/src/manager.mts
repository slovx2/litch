// 经理（litchManager）：设备持久化看板，客户端只经协议读写。定义见 protocol/extensions/manager.json。
// 本文件自包含，不引用 codex.mts。时间一律为 Unix 秒；id 在一块看板内唯一，经理 id 在设备内唯一。

export const MANAGER_METHOD = {
  list: 'litch/manager/list',
  create: 'litch/manager/create',
  update: 'litch/manager/update',
  end: 'litch/manager/end',
  boardRead: 'litch/manager/board/read',
  answersSubmit: 'litch/manager/answers/submit',
  decisionReopen: 'litch/manager/decision/reopen',
} as const

export const MANAGER_NOTIFICATION = {
  changed: 'litch/manager/changed',
  boardChanged: 'litch/manager/board/changed',
} as const

export type ManagerTemplate = 'release' | 'investigation' | 'research' | 'blank'
export type ManagerStatus = 'active' | 'ending' | 'ended'
export type ManagerDecisionId = `D-${number}`
export type ManagerItemId = `I-${number}`
export type ManagerObjectId = ManagerDecisionId | ManagerItemId

/** null 表示跟经理相同；换 harness 而未指定型号、强度时用目标 harness 默认值。 */
export interface ManagerDispatchSettings {
  harness: string | null
  model: string | null
  effort: string | null
  worktree: boolean
  merge: 'manager' | 'user'
  /** 正整数，默认 4；整棵子树在跑的会话合计，等待审批和后台任务也占名额。 */
  maxRunningLines: number
}

/** 第一版只支持桌面通知和一直等；手机推送、到期自动采用推荐不在契约内。 */
export interface ManagerContactSettings {
  desktopNotification: boolean
  unanswered: 'wait'
}

export const MANAGER_DEFAULT_DISPATCH: Readonly<ManagerDispatchSettings> = {
  harness: null,
  model: null,
  effort: null,
  worktree: true,
  merge: 'manager',
  maxRunningLines: 4,
}
export const MANAGER_DEFAULT_CONTACT: Readonly<ManagerContactSettings> = {
  desktopNotification: true,
  unanswered: 'wait',
}

/** 会话上的 litchManager：只投递给声明 litchManager 的连接，line 包括经理的整棵子树。 */
export type SessionManagerMark =
  | { managerId: string; role: 'manager' }
  | { managerId: string; role: 'line' }
export interface ManagerThreadFields {
  litchManager?: SessionManagerMark
}

/** 链接和依据的目标；文件路径按经理 cwd 解析，URL 用绝对地址，会话用设备上的 threadId。 */
export interface ManagerLink {
  kind: 'file' | 'branch' | 'commit' | 'thread' | 'url'
  target: string
  label: string | null
}
export interface ManagerChecked {
  /** 核对时的提交号；非仓库或未知是 null。 */
  commit: string | null
  at: number
}
export type ManagerActor = 'manager' | 'user' | 'user-conversation' | 'device'
export interface ManagerChange {
  id: string
  objectId: ManagerObjectId | 'status' | 'manager'
  by: ManagerActor
  at: number
  /** 哪些字段变了；变更前后完整值由设备留存，供 get 返回。 */
  fields: string[]
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  why: string
}

export interface ManagerDecisionOption {
  /** 在本决策内唯一且稳定；answer、recommend、default 都引用此 id，不用显示序号。 */
  id: string
  label: string
  description: string
}
export type ManagerDecisionDefault = { kind: 'ask' } | { kind: 'option'; optionId: string }
export interface ManagerAnswer {
  optionId: string | null
  text: string
  by: 'user' | 'user-conversation'
  at: number
}
export interface ManagerClosed {
  reason: string
  by: ManagerActor
  at: number
}
/** 第一版不产生 defaulted：没有截止时间调度。 */
export type ManagerDecisionStatus = 'open' | 'answered' | 'expired' | 'withdrawn'
export type ManagerItemStatus = 'backlog' | 'running' | 'review' | 'done' | 'deferred' | 'blocked'
export type ManagerItemOwner =
  | { kind: 'manager' }
  | { kind: 'user' }
  | { kind: 'line'; threadId: string }

export interface ManagerDecisionFields {
  title: string
  background: string
  options: ManagerDecisionOption[]
  recommend: string | null
  /** 记录不答时的意向；第一版仍一直等，不自动执行该选项。 */
  default: ManagerDecisionDefault
  blocks: ManagerItemId[]
  links: ManagerLink[]
  basis: ManagerLink[]
  landed: ManagerLink[]
}
export interface ManagerDecision extends ManagerDecisionFields {
  id: ManagerDecisionId
  /** 每次变更加一，答复必须带所读版本，防止按旧背景或选项答。 */
  revision: number
  status: ManagerDecisionStatus
  checked: ManagerChecked | null
  answer: ManagerAnswer | null
  closed: ManagerClosed | null
  createdAt: number
  updatedAt: number
}
export interface ManagerItemFields {
  title: string
  status: ManagerItemStatus
  owner: ManagerItemOwner
  blockedBy: ManagerDecisionId[]
  why: string
  links: ManagerLink[]
  basis: ManagerLink[]
  /** 从线的回报核对后记下的未验证项；只有用户能验的另建 owner=user 的事项。 */
  unverified: string[]
}
export interface ManagerItem extends ManagerItemFields {
  id: ManagerItemId
  revision: number
  checked: ManagerChecked | null
  createdAt: number
  updatedAt: number
}
export interface ManagerSituation {
  text: string
  at: number
}

/** 工作线全由会话树、回报和工作树事实现推，不由工具写入。未知事实用 null，不猜成零或否。 */
export interface ManagerLine {
  threadId: string
  parentThreadId: string
  title: string
  harness: string
  cwd: string
  status: 'running' | 'idle' | 'waiting' | 'error'
  /** 当前回合和后台任务是否占着并发名额。等待审批也为 true。 */
  running: boolean
  startedAt: number | null
  elapsedSeconds: number | null
  branch: string | null
  ahead: number | null
  merged: boolean | null
  worktreeExists: boolean | null
  report: { text: string; at: number } | null
  /** 从最近 wrap_up 回报中逐行取“没验：”开头的内容，保留前缀。 */
  unverified: string[]
}
export interface ManagerActivity {
  id: string
  kind: 'report' | 'merged' | 'decision' | 'item' | 'status' | 'manager'
  at: number
  text: string
  objectId: ManagerObjectId | null
  threadId: string | null
  changeId: string | null
}

export interface Manager {
  id: string
  threadId: string
  name: string
  scope: string
  cwd: string
  harness: string
  model: string | null
  effort: string | null
  template: ManagerTemplate
  dispatch: ManagerDispatchSettings
  contact: ManagerContactSettings
  rules: string
  status: ManagerStatus
  pendingDecisions: number
  runningLines: number
  latestActivity: ManagerActivity | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}
export interface ManagerBoard {
  managerId: string
  situation: ManagerSituation | null
  decisions: ManagerDecision[]
  items: ManagerItem[]
  lines: ManagerLine[]
  activities: ManagerActivity[]
  changes: ManagerChange[]
}

export type ManagerListParams = Record<string, never>
export interface ManagerListResponse {
  managers: Manager[]
}
export interface ManagerCreateParams {
  cwd: string
  harness: string
  model: string | null
  effort: string | null
  /** 空串由第一回合后自动命名。 */
  name: string
  scope: string
  template: ManagerTemplate
  dispatch: ManagerDispatchSettings
  contact: ManagerContactSettings
  /** 已由界面拼好或经用户编辑的文字，设备不得重新拼写覆盖。 */
  rules: string
  /** 空串表示使用内置开场：只排计划，等用户说开始。 */
  firstTask: string
}
export interface ManagerResponse {
  manager: Manager
}
export interface ManagerCreateResponse extends ManagerResponse {
  threadId: string
}
export interface ManagerIdParams {
  managerId: string
}
export interface ManagerPatch {
  name?: string
  scope?: string
  rules?: string
  /** 给了就整份替换；不改变已开出的线。 */
  dispatch?: ManagerDispatchSettings
  contact?: ManagerContactSettings
}
export interface ManagerUpdateParams extends ManagerIdParams, ManagerPatch {}
export type ManagerUpdateResponse = ManagerResponse
export type ManagerEndParams = ManagerIdParams
export type ManagerEndResponse = ManagerResponse
export type ManagerBoardReadParams = ManagerIdParams
export interface ManagerBoardReadResponse {
  board: ManagerBoard
}

/** optionId 非空或 text 非空，至少一种。数组内同一决策只能出现一次。 */
export interface ManagerSubmittedAnswer {
  decisionId: ManagerDecisionId
  revision: number
  optionId: string | null
  text: string
}
export interface ManagerAnswersSubmitParams extends ManagerIdParams {
  answers: ManagerSubmittedAnswer[]
}
export interface ManagerAnswerFailure {
  decisionId: ManagerDecisionId
  code: 'unknownDecision' | 'decisionConflict' | 'decisionNotOpen' | 'invalidAnswer'
  message: string
  /** 冲突或不再待定时附最新对象，供界面保留草稿并提示重新确认。 */
  decision: ManagerDecision | null
}
export interface ManagerAnswersSubmitResponse {
  /** 成功写入的完整对象；每项独立提交，失败项不阻止别项。 */
  accepted: ManagerDecision[]
  rejected: ManagerAnswerFailure[]
  /** 只要有成功项就持久化一条合并事件；送入回合失败时保留重试，不回滚答案。 */
  delivery: 'queued' | 'none'
}
export interface ManagerDecisionReopenParams extends ManagerIdParams {
  decisionId: ManagerDecisionId
}
export interface ManagerDecisionReopenResponse {
  decision: ManagerDecision
}
export interface ManagerChangedNotification {
  manager: Manager
}
/** 失效通知：收到后重新 board/read，不把局部数据当作完整快照。 */
export interface ManagerBoardChangedNotification extends ManagerIdParams {}

/** session-tree 的经理事件共同携带此来源；答复只传本次写成功的那些，不重复背景。 */
export interface ManagerEventData {
  managerId: string
  text: string
  answers?: {
    decisionId: ManagerDecisionId
    title: string
    optionId: string | null
    optionLabel: string | null
    text: string
  }[]
}

export const MANAGER_ERROR = {
  unknownManager: 'unknownManager',
  managerEnded: 'managerEnded',
  invalidManager: 'invalidManager',
  unknownDecision: 'unknownDecision',
  decisionNotClosed: 'decisionNotClosed',
  lineLimitReached: 'lineLimitReached',
} as const
