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
  ManagerStatus,
  ManagerSubmittedAnswer,
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
}
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
export interface ManagerBoardTopicView {
  deviceId: string
  managerId: string
  available: boolean | null
  board: ManagerBoardView | null
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
