import type {
  ExternalAuthorizedScope,
  ExternalCoverage,
  ExternalEvent,
  ExternalInboxEvent,
  ExternalIssueId,
  ExternalMandate,
  ExternalOutboxSummary,
  ExternalSubject,
  ExternalTriageResult,
  ExternalWriteReceipt,
} from '../../protocol/src/external-sources.mjs'
import type { ManagerIssue } from '../../protocol/src/manager-issues.mjs'

/** 平台当前对象状态，时间单位为秒；不保存正文。 */
export interface ExternalSubjectObservation {
  subject: ExternalSubject
  state: 'open' | 'closed' | 'merged'
  updatedAt: number
}

export interface ExternalCursor extends ExternalCoverage {
  sourceId: string
  window?: { from: number; to: number; nextPage?: string; expiresAt?: number }
  etag?: string
  etagKey?: string
  credentialGeneration?: number
  backoffReason?: string
}
export interface ExternalObservation {
  objectKey: string
  subjectKey: string
  objectId: string
  observedAt: number
  updatedAt: number
  contentHash?: string
  mentionsBot?: boolean
  seen: boolean
  unavailable?: 'deleted' | 'revoked' | 'unverified'
}
export type NewExternalInboxEvent = Omit<ExternalInboxEvent, 'seq' | 'revision'> & {
  evidence?: ExternalEvent
}
export interface ExternalPollCheckpoint {
  /** 来源适配器提供的操作性元数据，例如页证明、缺口、PR 目录或待取明细的定位键。 */
  bucket: string
  key: string
  value: object | null
}
export interface ExternalPollPage {
  cursor: ExternalCursor
  observations: readonly ExternalObservation[]
  checkpoints?: readonly ExternalPollCheckpoint[]
  events?: readonly NewExternalInboxEvent[]
}
export interface ExternalDeliveryGroup {
  groupId: string
  sourceId: string
  managerId: string
  issueId?: ExternalIssueId
  subjectKey: string
  eventKeys: string[]
  deliveryId?: string
  /** 发送点的实际线程；经理换绑后仍按此线程对账。 */
  target?: { threadId: string; harness: string }
  availableAt: number
  state: 'queued' | 'sending' | 'confirmed' | 'unknown' | 'blocked'
  turnId?: string
  reason?: string
}
export interface ExternalRunWatch {
  repoId: string
  runId: string
  attempt: number
  headSha: string
  workflowId: string
  prRef: ExternalSubject
  deadline: number
  observation: { status: string; conclusion?: string; at: number }
}
export interface ExternalOutboxRecord extends ExternalOutboxSummary {
  idempotencyKey: string
  actorThreadId: string
  mandateId?: string
  intakeId?: string
  resultReply?: true
  policyRevision: number
  payloadHash: string
  /** 仅指向设备内私有载荷；不进入列表、回执或审计。 */
  payloadRef: string
  leaseUntil?: number
}
export type NewExternalOutboxRecord = Omit<
  ExternalOutboxRecord,
  'seq' | 'revision' | 'state' | 'attempts' | 'receipt' | 'errorClass' | 'leaseUntil'
>
export interface ExternalWriteAttempt {
  operationId: string
  attempt: number
  startedAt: number
  finishedAt?: number
  outcome?: 'confirmed' | 'unknown' | 'retryable' | 'failed' | 'blocked'
  requestId?: string
  errorClass?: string
}
export interface ExternalWriteCompletion {
  outcome: NonNullable<ExternalWriteAttempt['outcome']>
  at: number
  nextAttempt?: number
  receipt?: ExternalWriteReceipt
  errorClass?: string
  requestId?: string
}
export interface ExternalAuditEntry {
  at: number
  subject: string
  action: string
  actorId?: string
  reason?: string
  previousState?: string
  state?: string
  rulesVersion?: number
  role?: string
  managerId?: string
  issueId?: ExternalIssueId
  eventKeys?: string[]
  operationId?: string
  policyRevision?: number
}

type ExternalTriageEvidence = Pick<
  ExternalMandate,
  | 'requesterUserId'
  | 'observedRole'
  | 'eventKeys'
  | 'ruleId'
  | 'rulesVersion'
  | 'routeId'
  | 'policyRevision'
> & { authorizedScope: ExternalAuthorizedScope }
export type ExternalTriageCommit = {
  intakeId: string
  expectedRevision: number
  idempotencyKey: string
  actorId: string
  at: number
} & (
  | {
      action: 'accept'
      managerId: string
      title: string
      body: string
      evidence: ExternalTriageEvidence
      relatedIssueId?: ExternalIssueId
    }
  | {
      action: 'merge'
      managerId: string
      issueId: ExternalIssueId
      expectedIssueRevision: number
      evidence: ExternalTriageEvidence
    }
  | { action: 'ignore'; managerId?: string; reason: string }
)
export interface ExternalTriageHooks {
  /** 复用 C 线现有看板派生（关系、未读索引等），只允许同库同步写入。 */
  onCreate?: (issue: ManagerIssue, relatedIssueId?: ExternalIssueId) => void
  reply?: NewExternalOutboxRecord | { notQueued: string }
}
export type ExternalTriageCommitResult = ExternalTriageResult
