// 经理 issue 的公共协议外壳。特殊 issue 的权威仍在 manager.mts、manager-posts.mts 和提案表；
// 这里定义 X-n 与现有类型编号、评论、时间线、过滤和设备通知，供设备与两端共用。
import type { ExternalIssueFields } from './external-sources.mjs'
import type { ManagerDecisionOption, ManagerDiscussion, ManagerQuestion } from './manager.mjs'
import type { ManagerRelation } from './manager-posts.mjs'

export const MANAGER_ISSUES_EXTENSION = 'litchManagerIssues' as const

export const MANAGER_ISSUE_METHOD = {
  list: 'litch/manager/issues/list',
  read: 'litch/manager/issue/read',
  create: 'litch/manager/issue/create',
  update: 'litch/manager/issue/update',
  comment: 'litch/manager/issue/comment',
  follow: 'litch/manager/issue/follow',
  seen: 'litch/manager/issue/seen',
} as const

export const MANAGER_ISSUE_NOTIFICATION = {
  changed: 'litch/manager/issue/changed',
  activity: 'litch/manager/issue/activity',
} as const

export type ManagerIssueId =
  | `X-${number}`
  | `D-${number}`
  | `R-${number}`
  | `P-${number}`
  | `S-${string}`
export type ManagerIssueRef = ManagerIssueId
export type ManagerIssueKind = 'ordinary' | 'decision' | 'suggestion' | 'request' | 'report'
export type ManagerIssueAuthorKind = 'user' | 'manager'
export type ManagerIssueActor = ManagerIssueAuthorKind | 'device' | 'question'
export type ManagerIssueFollowUp = 'on' | 'off'

export type ManagerOrdinaryStatus = 'open' | 'in_progress' | 'blocked' | 'resolved' | 'closed'
export type ManagerDecisionIssueStatus = 'open' | 'answered' | 'expired' | 'withdrawn' | 'ignored'
export type ManagerSuggestionIssueStatus =
  | 'pending'
  | 'endorsed'
  | 'started'
  | 'dismissed'
  | 'expired'
export type ManagerRequestIssueStatus = 'open' | 'delivered' | 'replied' | 'ignored' | 'cancelled'
export type ManagerReportIssueStatus = 'unread' | 'read'
export type ManagerIssueStatus =
  | ManagerOrdinaryStatus
  | ManagerDecisionIssueStatus
  | ManagerSuggestionIssueStatus
  | ManagerRequestIssueStatus
  | ManagerReportIssueStatus

/** 普通 issue 下一步在谁：user 等用户（待处理），agent 经理或工作线在跟（进行中）。 */
export type ManagerIssueWaitingOn = 'user' | 'agent'
/**
 * 判定依据：line 关联工作线在跑；turn 经理本回合在处理；paused 跟进已暂停；marked 经理显式标记；
 * blocked 受阻、经理按约定复查；user 用户最后发言、等经理；manager 经理最后回复、等用户。
 */
export type ManagerIssueWaitingWhy =
  | 'line'
  | 'turn'
  | 'paused'
  | 'marked'
  | 'blocked'
  | 'user'
  | 'manager'
/** 设备按规则派生，不落库；只有未结束的 X-n 有。需 litchManagerIssueWaiting。 */
export interface ManagerIssueWaiting {
  on: ManagerIssueWaitingOn
  why: ManagerIssueWaitingWhy
  /** 进行中超过阈值没有动静，改判为等用户 */
  stale?: true
  /** 判定所依据的最近一次动静（秒） */
  since: number
}
/** “可能卡住”的阈值：进行中这么久没有动静就算到待处理 */
export const MANAGER_ISSUE_STALE_SECONDS = 24 * 60 * 60

/** 跨类型列表使用的粗粒度状态；具体 status 仍由 kind 解释。 */
export type ManagerIssueStateGroup = 'open' | 'pending' | 'closed' | 'read' | 'unread'

export interface ManagerIssueAuthor {
  kind: ManagerIssueAuthorKind
  name?: string
}

export interface ManagerIssueFollowUpState {
  state: ManagerIssueFollowUp
  changedAt: number
  changedBy: ManagerIssueAuthorKind
}

export interface ManagerIssueComment {
  id: string
  revision: number
  author: ManagerIssueAuthor
  body: string
  createdAt: number
  updatedAt: number
  replyTo: string | null
}

export type ManagerIssueTimelineKind =
  | 'created'
  | 'comment'
  | 'question'
  | 'answer'
  | 'edited'
  | 'status'
  | 'followUp'
  | 'relation'
  | 'read'

export interface ManagerIssueTimelineEntry {
  id: string
  kind: ManagerIssueTimelineKind
  actor: ManagerIssueActor
  at: number
  summary: string
  commentId?: string
  changeId?: string
}

export interface ManagerIssueDiscussion {
  /** 用户已开启讨论；关闭抽屉不会撤销。仅向声明 litchManagerIssueDiscussions 的连接返回。 */
  opened?: boolean
  comments: ManagerIssueComment[]
  /** 旧“问经理/临时旁问”记录，保持与 ManagerDiscussion 相同的安全语义。 */
  questions: ManagerQuestion[]
  summary: string | null
  /** 旧字段只在 D/R/P/S 投影中存在，便于客户端渐进读取。 */
  legacy?: ManagerDiscussion
}

/** 是否已开启讨论：显式开启、公共评论或旧问答任一成立。 */
export function managerIssueHasDiscussion(issue: Pick<ManagerIssue, 'discussion'>): boolean {
  const d = issue.discussion
  return d.opened === true || d.comments.length > 0 || d.questions.length > 0
}

export interface ManagerIssueQuickActions {
  /** 特殊对象快速操作使用此版本；followUp 的公共版本不替代原对象 revision。 */
  revision?: number
  decision?: { options: ManagerDecisionOption[]; answerable: boolean; ignored: boolean }
  suggestion?: { proposalId: string; canStart: boolean; reviewed: boolean }
  request?: { buttonLabel: string | null; deliverable: boolean }
  report?: { unread: boolean; canMarkRead: boolean }
}

export interface ManagerIssue extends ExternalIssueFields {
  /** 普通 issue 为 X-n；D/R/P/S 保持原编号，I-n 不属于 issue。 */
  id: ManagerIssueId
  kind: ManagerIssueKind
  title: string
  body: string
  status: ManagerIssueStatus
  /** 经理设为受阻时给出的等待条件与跟进时间。 */
  blockedReason?: string
  waiting?: ManagerIssueWaiting
  stateGroup: ManagerIssueStateGroup
  author: ManagerIssueAuthor
  revision: number
  createdAt: number
  updatedAt: number
  followUp: ManagerIssueFollowUpState
  discussion: ManagerIssueDiscussion
  relations: ManagerRelation[]
  timeline: ManagerIssueTimelineEntry[]
  quick: ManagerIssueQuickActions
  unread: boolean
}

export interface ManagerIssueHead extends Pick<ExternalIssueFields, 'missingResultReply'> {
  id: ManagerIssueId
  kind: ManagerIssueKind
  title: string
  preview: string
  status: ManagerIssueStatus
  /** 经理设为受阻时给出的等待条件与跟进时间。 */
  blockedReason?: string
  waiting?: ManagerIssueWaiting
  stateGroup: ManagerIssueStateGroup
  author: ManagerIssueAuthorKind
  followUp: ManagerIssueFollowUp
  unread: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

export type ManagerIssueOrder = 'newest' | 'oldest' | 'pending' | 'updated'
export interface ManagerIssueQuery {
  managerId: string
  /** 只列 X-n 和已开启讨论或已有消息的特殊 issue；分页前应用。需 litchManagerIssueDiscussions。 */
  discussionsOnly?: boolean
  kinds?: ManagerIssueKind[]
  statuses?: ManagerIssueStatus[]
  authors?: ManagerIssueAuthorKind[]
  followUp?: ManagerIssueFollowUp | 'all'
  unread?: boolean
  /** 有它时 X-n 改按“未结束且 waiting.on 在其中”过滤，不看 statuses；其他类型照旧。需 litchManagerIssueWaiting。 */
  waiting?: ManagerIssueWaitingOn[]
  order: ManagerIssueOrder
  cursor?: string
  limit?: number
}

export interface ManagerIssuePage {
  query: ManagerIssueQuery
  entries: ManagerIssueHead[]
  total: number
  nextCursor: string | null
}

export interface ManagerIssueCreateParams {
  managerId: string
  title: string
  body: string
  source?: import('./manager-posts.mjs').ManagerRelationTarget[]
  related?: import('./manager-posts.mjs').ManagerRelationTarget[]
  followUp?: ManagerIssueFollowUp
  idempotencyKey?: string
}

export interface ManagerIssueUpdateParams {
  managerId: string
  id: ManagerIssueRef
  revision: number
  patch: {
    /** 只允许置为 true，不改变特殊类型的快速处理状态。需 litchManagerIssueDiscussions。 */
    discussionOpened?: true
    title?: string
    body?: string
    status?: ManagerOrdinaryStatus
    followUp?: ManagerIssueFollowUp
    /** 经理纠正自动判定；用户随后有任何动作即失效。只接受经理调用，需 litchManagerIssueWaiting。 */
    waitingOn?: ManagerIssueWaitingOn
    source?: import('./manager-posts.mjs').ManagerRelationTarget[]
    related?: import('./manager-posts.mjs').ManagerRelationTarget[]
  }
  why: string
}

export interface ManagerIssueCommentParams {
  managerId: string
  id: ManagerIssueRef
  revision: number
  body: string
  replyTo?: string | null
  idempotencyKey?: string
  /** 编辑自己的评论时同时提供；评论版本与原帖版本独立。 */
  commentId?: string
  commentRevision?: number
}

export interface ManagerIssueFollowParams {
  managerId: string
  id: ManagerIssueRef
  revision: number
  state: ManagerIssueFollowUp
  why?: string
}

export interface ManagerIssueSeenParams {
  managerId: string
  id: ManagerIssueRef
  revision: number
}

export interface ManagerIssueDetail {
  issue: ManagerIssue
}

export interface ManagerIssueChangedNotification {
  managerId: string
  issueId: ManagerIssueId
  revision: number
  change: 'created' | 'updated' | 'commented' | 'status' | 'followUp' | 'read'
}

export interface ManagerIssueActivityNotification {
  managerId: string
  issueId: ManagerIssueId
  eventId: string
  kind: 'issue-created' | 'issue-comment' | 'issue-updated'
  actor: ManagerIssueActor
  followUp: ManagerIssueFollowUp
  unread: boolean
}

export interface ManagerIssueRequests {
  [MANAGER_ISSUE_METHOD.list]: {
    params: ManagerIssueQuery
    result: { page: ManagerIssuePage }
  }
  [MANAGER_ISSUE_METHOD.read]: {
    params: { managerId: string; id: ManagerIssueRef }
    result: ManagerIssueDetail
  }
  [MANAGER_ISSUE_METHOD.create]: {
    params: ManagerIssueCreateParams
    result: ManagerIssueDetail
  }
  [MANAGER_ISSUE_METHOD.update]: {
    params: ManagerIssueUpdateParams
    result: ManagerIssueDetail
  }
  [MANAGER_ISSUE_METHOD.comment]: {
    params: ManagerIssueCommentParams
    result: ManagerIssueDetail
  }
  [MANAGER_ISSUE_METHOD.follow]: {
    params: ManagerIssueFollowParams
    result: ManagerIssueDetail
  }
  [MANAGER_ISSUE_METHOD.seen]: {
    params: ManagerIssueSeenParams
    result: ManagerIssueDetail
  }
}

export const managerIssueRefKind = (ref: string): 'ordinary' | 'special' | 'invalid' => {
  if (/^X-[1-9][0-9]*$/.test(ref)) return 'ordinary'
  if (/^(D|R|P)-[1-9][0-9]*$/.test(ref) || /^S-.+$/.test(ref)) return 'special'
  return 'invalid'
}

export const managerIssueFixture = {
  migratedDecision: {
    id: 'D-7',
    kind: 'decision',
    title: '保留旧链接',
    body: '原编号保持不变。',
    status: 'open',
    stateGroup: 'pending',
    author: { kind: 'manager' },
    revision: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    followUp: { state: 'on', changedAt: 1_700_000_000, changedBy: 'manager' },
    discussion: { comments: [], questions: [], summary: null },
    relations: [],
    timeline: [
      {
        id: 'created:D-7',
        kind: 'created',
        actor: 'manager',
        at: 1_700_000_000,
        summary: 'created',
      },
    ],
    quick: { decision: { options: [], answerable: true, ignored: false } },
    unread: false,
  } satisfies ManagerIssue,
  newOrdinary: {
    id: 'X-1',
    kind: 'ordinary',
    title: '用户跟进',
    body: '等待评论。',
    status: 'open',
    stateGroup: 'open',
    author: { kind: 'user' },
    revision: 1,
    createdAt: 1_700_000_001,
    updatedAt: 1_700_000_001,
    followUp: { state: 'on', changedAt: 1_700_000_001, changedBy: 'user' },
    discussion: { comments: [], questions: [], summary: null },
    relations: [],
    timeline: [
      { id: 'created:X-1', kind: 'created', actor: 'user', at: 1_700_000_001, summary: 'created' },
    ],
    quick: {},
    unread: false,
  } satisfies ManagerIssue,
} as const
