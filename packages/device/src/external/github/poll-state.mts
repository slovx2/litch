import type { ExternalEvent } from '../../../../protocol/src/external-sources.mjs'
import type { GithubBoundPull, GithubRunDiscovery, GithubRunKey } from './actions.mjs'
import type { GithubActorEvidence } from './identity.mjs'
import type { GithubFault } from './read-api.mjs'
import type { GithubContentKind } from './read-content.mjs'

export type GithubStream =
  | 'issues'
  | 'issue-events'
  | 'issue-comments'
  | 'review-comments'
  | `notifications:${string}`
  | `subject-comments:${number}`
  | `subject-review-comments:${number}`
  | `reviews:${number}`
  | `pull:${number}`
  | `runs:${number}`
export interface GithubScope {
  sourceId: string
  repoId: string
}
export interface GithubStreamKey extends GithubScope {
  stream: GithubStream
}
export type GithubSubjectKind = 'issue' | 'pull'
export type GithubIssueAction =
  | 'assigned'
  | 'unassigned'
  | 'labeled'
  | 'unlabeled'
  | 'review_requested'
  | 'review_request_removed'
  | 'closed'
  | 'reopened'

// 归一事件直接沿用公共协议；内部扫描时间仍为毫秒，入库时转换。
export type GithubPollEvent = ExternalEvent
export type GithubTargetEvidence = ExternalEvent['targetEvidence']

export interface GithubObjectObservation {
  objectKey: string
  subjectKey: string
  objectId: string
  observedAt: number
  updatedAt: number
  hash: string
  mentioned: boolean
}

export interface GithubPullCandidate {
  number: number
  state?: 'open' | 'closed'
  updatedAt?: number
  closedAt?: number
  discoveredAt: number
  bound?: true
}

export interface GithubPullObservation extends GithubBoundPull {
  state: 'open' | 'closed'
  updatedAt: number
  closedAt?: number
  mergedAt?: number
}

/** 对象当前状态独立于正文版本；评论、关闭和重新打开都可能只推进更新时间。 */
export interface GithubSubjectObservation {
  subject: ExternalEvent['targetEvidence']['subject']
  state: 'open' | 'closed' | 'merged'
  updatedAt: number
}

export interface GithubContentCandidate
  extends Pick<
    GithubObjectObservation,
    'objectKey' | 'objectId' | 'updatedAt' | 'hash' | 'mentioned'
  > {
  kind: GithubContentKind
  number: number
  createdAt: number
  actor: GithubActorEvidence | null
}

export interface GithubActionStub {
  id: string
  action: GithubIssueAction
  at: number
  actor?: GithubActorEvidence
  assigneeId?: string
  reviewerId?: string
  labelId?: string
  labelName?: string
}

export type GithubDetailTask =
  | { kind: 'parent'; candidate: GithubContentCandidate }
  | { kind: 'pull'; number: number; expectedId?: string }
  | {
      kind: 'timeline'
      number: number
      subjectKind: GithubSubjectKind
      remaining: GithubActionStub[]
      next?: string
    }
  | { kind: 'run'; key: GithubRunKey }

export interface GithubPageProof {
  // path 为完整请求路径（含查询串）；API 版本、凭据代、机器人当前登录名均在 tag 内。
  path: string
  tag: string
  etag: string
  next: string | null
  from: number
  before: number | null
  latestEventAt?: number
  checkedAt: number
  rows: number
}

export interface GithubGap {
  reason:
    | 'offline-limit'
    | 'page-budget'
    | 'expired-scan'
    | 'platform-limit'
    | 'evidence-unavailable'
  from: number
  to: number
  status: 'pending' | 'unrecoverable' | 'resolved'
  subjectNumber?: number
}

export interface GithubScan {
  kind: 'forward' | 'repair'
  from: number
  to: number
  expiresAt: number
  next: string | null
  rows: number
  pendingGap?: true
  expiredRange?: { from: number; to: number }
  pending?: { next: string | null; proof?: GithubPageProof; tasks: GithubDetailTask[] }
}

export interface GithubCursor {
  tag: string
  coveredThrough: number
  startedAt?: number
  checkedAt?: number
  repairAt?: number
  nextPollAt?: number
  scan?: GithubScan
  stopped?: 'platform-limit'
  fault?: GithubPollFault
  notifications?: {
    seen: { id: string; updatedAt: number }[]
    // 条件头只对应已经处理完的同一查询。
    conditional?: { path: string; etag?: string; modified?: string }
    pending?: { path: string; next: string; newestAt: number }
  }
}

export interface GithubPollFault {
  kind: GithubFault['kind']
  scope: 'credential' | 'repository' | 'stream' | 'target'
  paused: boolean
  reason:
    | 'credential-rejected'
    | 'repository-unavailable'
    | 'repository-changed'
    | 'permission-denied'
    | 'endpoint-unavailable'
    | 'feature-disabled'
    | 'target-unavailable'
    | 'retry'
  retryAt?: number
}

export interface GithubPageChanges {
  subjects?: readonly GithubSubjectObservation[]
  events?: readonly GithubPollEvent[]
  observations?: readonly GithubObjectObservation[]
  candidates?: readonly GithubPullCandidate[]
  pulls?: readonly GithubPullObservation[]
  runs?: readonly Exclude<GithubRunDiscovery, { state: 'unrelated' }>[]
  gaps?: readonly GithubGap[]
  proof?: GithubPageProof
}

export interface GithubAccessGate {
  generation: string
  fault: GithubPollFault
}

export interface GithubReviewSelection {
  boundNumbers?: readonly number[]
  boundOnly?: boolean
  resume?: boolean
  tag?: string
}

export interface GithubPollStore {
  getGate(key: { sourceId: string; repoId?: string }): Promise<GithubAccessGate | undefined>
  setGate(key: { sourceId: string; repoId?: string }, gate: GithubAccessGate | null): Promise<void>
  getCursor(key: GithubStreamKey): Promise<GithubCursor | undefined>
  getObservation(
    scope: GithubScope,
    objectKey: string,
  ): Promise<GithubObjectObservation | undefined>
  getPage(key: GithubStreamKey, path: string): Promise<GithubPageProof | undefined>
  // 已绑定、open、近期关闭或有新发现的 PR 为候选；先选尚未查过及上次核对最早者。
  listReviewCandidates(
    scope: GithubScope,
    recentSince: number,
    limit: number,
    selection?: GithubReviewSelection,
  ): Promise<readonly number[]>
  // 同一事务：替换游标、入账事件（按 externalEventKey 去重）、保存观察、候选、缺口及页证明。
  // 多来源共享事件键，其他数据按 sourceId/repoId/stream 隔离。正文永不交给存储。
  commit(key: GithubStreamKey, cursor: GithubCursor, changes: GithubPageChanges): Promise<void>
}
