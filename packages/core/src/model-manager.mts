// 经理的界面契约。协议里的时间是秒，这里的时间字段（含嵌套对象）统一为毫秒。
// elapsedSeconds 是时长，不做转换；变更记录 before/after 是审计原文，保留协议单位。
// 本文件只写类型，投影、订阅、模拟数据由核心实现线接入。
import type {
  Manager,
  ManagerActivity,
  ManagerAnswer,
  ManagerAnswerFailure,
  ManagerBoard,
  ManagerChange,
  ManagerChecked,
  ManagerClosed,
  ManagerCreateParams,
  ManagerDecision,
  ManagerItem,
  ManagerLine,
  ManagerPatch,
  ManagerRequest,
  ManagerSituation,
} from '../../protocol/src/manager.mjs'

export type {
  ManagerContactSettings,
  ManagerDecisionDefault,
  ManagerDecisionId,
  ManagerDecisionOption,
  ManagerDecisionStatus,
  ManagerDispatchSettings,
  ManagerItemId,
  ManagerItemOwner,
  ManagerItemStatus,
  ManagerLink,
  ManagerObjectId,
  ManagerPatch,
  ManagerRequestId,
  ManagerStatus,
  ManagerSubmittedAnswer,
  ManagerSubmittedQuestion,
  ManagerSubmittedRequest,
  ManagerTemplate,
  SessionManagerMark,
} from '../../protocol/src/manager.mjs'

/** at 为毫秒。 */
export interface ManagerCheckedView extends ManagerChecked {}
export interface ManagerAnswerView extends ManagerAnswer {}
export interface ManagerClosedView extends ManagerClosed {}
export interface ManagerSituationView extends ManagerSituation {}
export interface ManagerChangeView extends ManagerChange {}
export interface ManagerActivityView extends ManagerActivity {}

export interface ManagerDecisionView
  extends Omit<ManagerDecision, 'checked' | 'answer' | 'closed'> {
  checked: ManagerCheckedView | null
  answer: ManagerAnswerView | null
  closed: ManagerClosedView | null
  /**
   * 重新打开前的最后一次关闭：设备重开时清掉 closed，这里从看板的变更记录里找回，只在待定时有值。
   * 客户端推出来的，不在设备契约里；答复结果等没有变更记录的来源不带它。
   */
  previousClosed?: ManagerClosedView | null
  /** 经理把用户忽略的决策重新打开的记录（by=manager，reason 是经理写的理由）：同样从变更记录推出，只在待定时有值 */
  reopened?: ManagerClosedView | null
}
export interface ManagerRequestView extends ManagerRequest {}
export interface ManagerItemView extends Omit<ManagerItem, 'checked'> {
  checked: ManagerCheckedView | null
}
export interface ManagerLineView extends ManagerLine {}
export interface ManagerView extends Omit<Manager, 'latestActivity'> {
  deviceId: string
  latestActivity: ManagerActivityView | null
}

/** 列表常驻订阅；available=null 尚未知，false 不支持。断线保留最近快照，重连后对账。 */
export interface ManagersView {
  deviceId: string
  available: boolean | null
  managers: ManagerView[]
}
export interface ManagerBoardView
  extends Omit<
    ManagerBoard,
    'decisions' | 'items' | 'lines' | 'activities' | 'changes' | 'situation'
  > {
  deviceId: string
  situation: ManagerSituationView | null
  decisions: ManagerDecisionView[]
  items: ManagerItemView[]
  lines: ManagerLineView[]
  activities: ManagerActivityView[]
  changes: ManagerChangeView[]
}
/** 看板按经理订阅；还没读到时 board=null，不把空看板误当作真实数据。 */
/**
 * 设备支持哪些后加的经理能力（设备信息 extensions 里的 litchManagerFeedback / Posts / Ignore）。
 * 没有的是比应用旧的设备服务：界面禁用对应入口并写明原因，核心也不发这些请求。
 */
export interface ManagerFeaturesView {
  issues?: boolean
  /** 用户忽略请你做请求 */
  requestIgnore?: boolean
  paging?: boolean
  /** 答复、决策追问、请你做交付同批提交（feedback/submit）；没有时只能交决策答复 */
  feedback: boolean
  /** 议题追问、报告标已阅、编号预览、临时追问与转给经理 */
  posts: boolean
  /** 忽略决策、撤销忽略 */
  ignore: boolean
}
export interface ManagerBoardTopicView {
  issues?: import('./model-manager-issues.mjs').ManagerIssuesView
  loadError?: string
  /** 分页模式下 board 仅含已加载详情，不能用数组长度推总数。 */
  paging?: ManagerPagingView
  deviceId: string
  managerId: string
  available: boolean | null
  board: ManagerBoardView | null
  features: ManagerFeaturesView
}
export interface ManagerPagingView {
  summary: import('../../protocol/src/manager-paging.mjs').ManagerBoardSummary
  pages: Record<string, import('../../protocol/src/manager-paging.mjs').ManagerObjectPage>
  histories: Record<string, import('../../protocol/src/manager-paging.mjs').ManagerHistoryPage>
  loading: string[]
  error: string | null
}
export type ManagerDraft = ManagerCreateParams
export type ManagerEdit = ManagerPatch
export interface ManagerAnswerFailureView extends Omit<ManagerAnswerFailure, 'decision'> {
  decision: ManagerDecisionView | null
}
export interface ManagerAnswersResult {
  accepted: ManagerDecisionView[]
  rejected: ManagerAnswerFailureView[]
  delivery: 'queued' | 'none'
}
