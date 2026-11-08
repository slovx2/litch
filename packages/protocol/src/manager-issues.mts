// 经理 issue 的公共协议外壳。特殊 issue 的权威仍在 manager.mts、manager-posts.mts 和提案表；
// 这里定义 canonical #n、历史别名、评论、时间线、过滤和设备通知，供设备与两端共用。
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

export type ManagerIssueId = `#${number}`
export type ManagerIssueAlias = `D-${number}` | `R-${number}` | `P-${number}` | `S-${string}`
export type ManagerIssueRef = ManagerIssueId | ManagerIssueAlias
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

/** 跨类型列表使用的粗粒度状态；具体 status 仍由 kind 解释。 */
export type ManagerIssueStateGroup = 'open' | 'pending' | 'closed' | 'read' | 'unread'

export interface ManagerIssueAuthor {
  kind: ManagerIssueAuthorKind
  name?: string
}

export interface ManagerIssueAliasRecord {
  alias: ManagerIssueAlias
  issueId: ManagerIssueId
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
  comments: ManagerIssueComment[]
  /** 旧“问经理/临时旁问”记录，保持与 ManagerDiscussion 相同的安全语义。 */
  questions: ManagerQuestion[]
  summary: string | null
  /** 旧字段只在 D/R/P/S 投影中存在，便于客户端渐进读取。 */
  legacy?: ManagerDiscussion
}

export interface ManagerIssueQuickActions {
  decision?: { options: ManagerDecisionOption[]; answerable: boolean; ignored: boolean }
  suggestion?: { proposalId: string; canStart: boolean; reviewed: boolean }
  request?: { buttonLabel: string | null; deliverable: boolean }
  report?: { unread: boolean; canMarkRead: boolean }
}

export interface ManagerIssue {
  /** 新对象和新协议响应只使用 canonical #n。 */
  id: ManagerIssueId
  /** 历史 D/R/P/S 只作为解析别名，不是第二个主键。 */
  aliases: ManagerIssueAlias[]
  kind: ManagerIssueKind
  title: string
  body: string
  status: ManagerIssueStatus
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

export interface ManagerIssueHead {
  id: ManagerIssueId
  aliases: ManagerIssueAlias[]
  kind: ManagerIssueKind
  title: string
  preview: string
  status: ManagerIssueStatus
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
  kinds?: ManagerIssueKind[]
  statuses?: ManagerIssueStatus[]
  authors?: ManagerIssueAuthorKind[]
  followUp?: ManagerIssueFollowUp | 'all'
  unread?: boolean
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
    title?: string
    body?: string
    status?: ManagerOrdinaryStatus
    followUp?: ManagerIssueFollowUp
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

export const managerIssueRefKind = (ref: string): 'canonical' | 'alias' | 'invalid' => {
  if (/^#[1-9][0-9]*$/.test(ref)) return 'canonical'
  if (/^(D|R|P)-[1-9][0-9]*$/.test(ref) || /^S-.+$/.test(ref)) return 'alias'
  return 'invalid'
}

export const managerIssueFixture = {
  migratedDecision: {
    id: '#1',
    aliases: ['D-7'],
    kind: 'decision',
    title: '保留旧链接',
    body: '迁移后仍能打开。',
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
        id: 'created:#1',
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
    id: '#2',
    aliases: [],
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
      { id: 'created:#2', kind: 'created', actor: 'user', at: 1_700_000_001, summary: 'created' },
    ],
    quick: {},
    unread: false,
  } satisfies ManagerIssue,
} as const
