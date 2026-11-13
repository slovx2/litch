import { MANAGER_POST_METHOD } from './manager-posts.mjs'
// 经理（litchManager）：设备持久化看板，客户端只经协议读写。定义见 protocol/extensions/manager.json。
// 本文件自包含，不引用 codex.mts。时间一律为 Unix 秒；id 在一块看板内唯一，经理 id 在设备内唯一。

export const MANAGER_METHOD = {
  list: 'litch/manager/list',
  create: 'litch/manager/create',
  update: 'litch/manager/update',
  end: 'litch/manager/end',
  reset: 'litch/manager/reset',
  resetPreview: 'litch/manager/reset/preview',
  resetCancel: 'litch/manager/reset/cancel',
  boardRead: 'litch/manager/board/read',
  answersSubmit: 'litch/manager/answers/submit',
  feedbackSubmit: 'litch/manager/feedback/submit',
  decisionReopen: 'litch/manager/decision/reopen',
  decisionIgnore: 'litch/manager/decision/ignore',
  questionAsk: 'litch/manager/question/ask',
  questionForward: 'litch/manager/question/forward',
  ...MANAGER_POST_METHOD,
} as const

export const MANAGER_NOTIFICATION = {
  changed: 'litch/manager/changed',
  boardChanged: 'litch/manager/board/changed',
} as const

export type ManagerTemplate = 'release' | 'investigation' | 'research' | 'blank'
export type ManagerStatus = 'active' | 'ending' | 'ended'
export type ManagerDecisionId = `D-${number}`
export type ManagerItemId = `I-${number}`
export type ManagerRequestId = `R-${number}`
export type ManagerObjectId =
  | ManagerDecisionId
  | ManagerItemId
  | ManagerRequestId
  | import('./manager-posts.mjs').ManagerPostId

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
  worktree: false,
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
export type ManagerActor = 'manager' | 'user' | 'user-conversation' | 'device' | 'question'
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
/**
 * 第一版不产生 defaulted：没有截止时间调度。ignored 是用户在看板上忽略的结局，closed 记下谁、何时、可选理由；
 * 不计入待处理、不唤醒经理，用户可撤销（decision/reopen），经理要带理由用 litch_manager.reopen 才能重开。
 */
export type ManagerDecisionStatus = 'open' | 'answered' | 'expired' | 'withdrawn' | 'ignored'
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
  /** 设备持久化的旁问；不属于答复草稿，也不改变决策版本。 */
  discussion?: ManagerDiscussion
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
export interface ManagerQuestion {
  mode?: 'manager' | 'temporary'
  answeredAt?: number
  updatedPost?: boolean
  id: string
  question: string
  answer: string | null
  status: 'running' | 'completed' | 'failed'
  refreshed: boolean
  at: number
}
export interface ManagerDiscussion {
  messages: ManagerQuestion[]
  /** 无经理历史的轻会话。 */
  light: boolean
  summary: string | null
  forwarded: number
}
export interface ManagerQuestionParams extends ManagerIdParams {
  decisionId: ManagerDecisionId
  revision: number
  question: string
}
export interface ManagerItemFields {
  title: string
  status: ManagerItemStatus
  owner: ManagerItemOwner
  blockedBy: ManagerDecisionId[]
  why: string
  links: ManagerLink[]
  basis: ManagerLink[]
  /** 从线的回报核对后记下的未验证项；只能由用户完成的检查保留说明，不新建用户事项。 */
  unverified: string[]
}
export interface ManagerItem extends ManagerItemFields {
  id: ManagerItemId
  revision: number
  checked: ManagerChecked | null
  createdAt: number
  updatedAt: number
}
/** 新写入的现状最多 1000 个 Unicode 字符；历史内容读取时不截断。 */
export const MANAGER_SITUATION_LIMIT = 1000
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
export type ManagerActivitySource =
  | { kind: 'manager' | 'user' | 'system' }
  | { kind: 'line'; threadId: string; title: string }
export interface ManagerActivity {
  source?: ManagerActivitySource
  id: string
  kind: 'report' | 'merged' | 'decision' | 'item' | 'request' | 'status' | 'manager'
  at: number
  text: string
  objectId: ManagerObjectId | null
  threadId: string | null
  changeId: string | null
}

export interface Manager {
  /** 设备生成的能力指纹；旧快照未核验时 applied 为 null。 */
  reset?: ManagerResetState
  historyThreadIds?: string[]
  id: string
  threadId: string
  name: string
  scope: string
  cwd: string
  harness: string
  model: string | null
  effort: string | null
  permission?: string | null
  template: ManagerTemplate
  dispatch: ManagerDispatchSettings
  contact: ManagerContactSettings
  /** 用户自定义的经理设定原文，可为空；自动行为规则由设备另行生成。 */
  rules: string
  status: ManagerStatus
  pendingDecisions: number
  /** 仍待用户操作的请你做；已回复、已交付及已取消不计入。 */
  pendingRequests?: number
  pendingReports?: number
  pendingSuggestions?: number
  runningLines: number
  latestActivity: ManagerActivity | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}
export interface ManagerResetState {
  /** 仅向声明 litchManagerResetTarget 的连接投递。 */
  operation?: ManagerResetOperation
  mode: 'refresh' | 'replace'
  current: string
  applied: string | null
  outdated: boolean
  phase: 'idle' | 'waiting' | 'summarizing' | 'applying' | 'ready' | 'failed' | 'summaryFailed'
  error?: string
}
export interface ManagerResetParams {
  managerId: string
  /** 仅摘要失败后二次确认允许；默认必须取得摘要。 */
  boardOnly?: boolean
  target?: ManagerResetTarget
  expectedThreadId?: string
  expectedSettingsHash?: string
  requestId?: string
}
export const MANAGER_RESET_TARGET_EXTENSION = 'litchManagerResetTarget' as const
export interface ManagerResetTarget {
  harness: string
  /** null 请求目标默认；预览会解析为具体型号与强度。 */
  model: string | null
  effort: string | null
  permission: string
  dispatch?: ManagerDispatchSettings
}
export interface ManagerResetSettings {
  harness: string
  model: string | null
  effort: string | null
  permission: string | null
}
export interface ManagerResetIssue {
  code: string
  field?: string
  message: string
}
export interface ManagerResetCandidate {
  harness: string
  enabled: boolean
  reasons: ManagerResetIssue[]
  models: { id: string; name: string; efforts: string[]; defaultEffort: string | null }[]
  defaultModel: string | null
  permissions: string[]
}
export interface ManagerResetPreviewParams {
  managerId: string
  /** 不传时预览源实际设置，同时返回候选目录。 */
  target?: ManagerResetTarget
}
export interface ManagerResetPreview {
  managerId: string
  cwd: string
  expectedThreadId: string
  expectedSettingsHash: string
  source: ManagerResetSettings
  target: ManagerResetTarget
  mode: 'refresh' | 'replace'
  canSubmit: boolean
  reasons: ManagerResetIssue[]
  candidates: ManagerResetCandidate[]
  /** 能力差异以稳定能力名表示，文案由客户端生成。 */
  capabilityChanges: { capability: string; before: boolean; after: boolean }[]
  dispatchChanges: {
    field: 'harness' | 'model' | 'effort'
    before: string | null
    after: string | null
  }[]
}
export interface ManagerResetOperation {
  requestId: string
  source: ManagerResetSettings & { threadId: string }
  target: ManagerResetTarget
  expectedSettingsHash: string
  candidateThreadId: string | null
  committed: boolean
  /** 已提交也可能尚未成功投递接班首轮。 */
  handover: 'pending' | 'accepted' | 'failed'
}
export interface ManagerResetResponse extends ManagerResponse {
  /** 本次 requestId 的幂等回执；manager.reset 始终投影经理当前的操作。 */
  operation?: ManagerResetOperation
}
/** 只取消 waiting；已开始摘要或提交时返回 managerResetBusy，已结束时幂等返回。 */
export interface ManagerResetCancelParams {
  managerId: string
}
export interface ManagerRequestFields {
  title: string
  description: string
  buttonLabel: string | null
  basis: ManagerLink[]
  links: ManagerLink[]
}
export interface ManagerRequest extends ManagerRequestFields {
  id: ManagerRequestId
  revision: number
  status: 'open' | 'delivered' | 'replied' | 'cancelled'
  /** ignored 只增加结果信息；底层 status 仍用 replied，既有字段与枚举保持不变。 */
  response: { delivered: boolean; text: string; at: number; ignored?: boolean } | null
  cancelled: { reason: string; at: number } | null
  createdAt: number
  updatedAt: number
}
export interface ManagerSubmittedRequest {
  requestId: ManagerRequestId
  revision: number
  delivered: boolean
  text: string
  /** 用户忽略请求；delivered 必须为 false，text 是选填理由。 */
  ignored?: boolean
}
/** 展示、计数与筛选使用同一结果：经理取消优先于历史中的用户答复。 */
export function managerRequestStatus(
  request: Pick<ManagerRequest, 'status' | 'response'>,
): ManagerRequest['status'] | 'ignored' {
  return request.status === 'replied' && request.response?.ignored === true
    ? 'ignored'
    : request.status
}
export interface ManagerRequestFailure {
  requestId: ManagerRequestId
  code: 'unknownRequest' | 'requestConflict' | 'requestCancelled' | 'invalidRequest'
  message: string
  request: ManagerRequest | null
}
export interface ManagerBoard {
  relations?: import('./manager-posts.mjs').ManagerRelation[]
  posts?: import('./manager-posts.mjs').ManagerPost[]
  managerId: string
  situation: ManagerSituation | null
  decisions: ManagerDecision[]
  items: ManagerItem[]
  requests?: ManagerRequest[]
  lines: ManagerLine[]
  activities: ManagerActivity[]
  changes: ManagerChange[]
}

export type ManagerListParams = Record<string, never>
export interface ManagerListResponse {
  managers: Manager[]
}
export interface ManagerCreateParams {
  permission?: string | null
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
export interface ManagerSubmittedQuestion {
  decisionId: ManagerDecisionId
  revision: number
  question: string
}
export interface ManagerFeedbackSubmitParams extends ManagerAnswersSubmitParams {
  requests?: ManagerSubmittedRequest[]
  questions: ManagerSubmittedQuestion[]
}
export interface ManagerFeedbackSubmitResponse extends ManagerAnswersSubmitResponse {
  acceptedRequests: ManagerRequest[]
  rejectedRequests: ManagerRequestFailure[]
  acceptedQuestions: ManagerDecision[]
  rejectedQuestions: ManagerAnswerFailure[]
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
/** 用户忽略一条待定决策；revision 是所读版本，理由可空。 */
export interface ManagerDecisionIgnoreParams extends ManagerIdParams {
  decisionId: ManagerDecisionId
  revision: number
  reason?: string
}
export interface ManagerDecisionIgnoreResponse {
  decision: ManagerDecision
}
export interface ManagerChangedNotification {
  manager: Manager
}
/** 失效通知：收到后重新 board/read，不把局部数据当作完整快照。 */
export interface ManagerBoardChangedNotification extends ManagerIdParams {}

/** session-tree 的经理事件共同携带此来源；答复只传本次写成功的那些，不重复背景。 */
export interface ManagerEventData {
  /** 通用议题追问；旧 questions 字段仍只表示决策。 */
  postQuestions?: {
    id: import('./manager-posts.mjs').ManagerPostId
    revision: number
    title: string
    question: string
  }[]
  managerId: string
  text: string
  requests?: (ManagerSubmittedRequest & { title: string; buttonLabel: string | null })[]
  questions?: (ManagerSubmittedQuestion & { title: string })[]
  answers?: {
    decisionId: ManagerDecisionId
    title: string
    optionId: string | null
    optionLabel: string | null
    text: string
    discussion?: ManagerDiscussion
  }[]
  /** manager-ignored 事件：用户忽略了哪些决策（理由可为空字符串）。 */
  ignored?: { decisionId: ManagerDecisionId; title: string; reason: string }[]
}

export const MANAGER_ERROR = {
  unknownManager: 'unknownManager',
  managerEnded: 'managerEnded',
  invalidManager: 'invalidManager',
  unknownDecision: 'unknownDecision',
  decisionNotClosed: 'decisionNotClosed',
  decisionNotOpen: 'decisionNotOpen',
  decisionConflict: 'decisionConflict',
  lineLimitReached: 'lineLimitReached',
} as const
