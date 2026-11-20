// 设备外部来源与收件箱。平台数字 ID 始终用十进制字符串，时间用 UTC epoch 秒。

import type { ManagerAnswer } from './manager.mjs'
import type { ManagerIssueId } from './manager-issues.mjs'

export const EXTERNAL_SOURCES_EXTENSION = 'litchExternalSources'
export const EXTERNAL_METHOD = {
  ownerGet: 'litch/external/owner/get',
  ownerSet: 'litch/external/owner/set',
  credentialConfigure: 'litch/external/credential/configure',
  credentialRotate: 'litch/external/credential/rotate',
  credentialRevoke: 'litch/external/credential/revoke',
  sourceList: 'litch/external/source/list',
  sourceGet: 'litch/external/source/get',
  sourceUpsert: 'litch/external/source/upsert',
  sourcePreview: 'litch/external/source/preview',
  sourcePause: 'litch/external/source/pause',
  sourceResume: 'litch/external/source/resume',
  sourceCheck: 'litch/external/source/check',
  inboxList: 'litch/external/inbox/list',
  inboxGet: 'litch/external/inbox/get',
  inboxTriage: 'litch/external/inbox/triage',
  outboxList: 'litch/external/outbox/list',
  outboxGet: 'litch/external/outbox/get',
  outboxReconcile: 'litch/external/outbox/reconcile',
  outboxCancel: 'litch/external/outbox/cancel',
} as const
export const EXTERNAL_NOTIFICATION = {
  sourcesChanged: 'litch/external/sourcesChanged',
  inboxChanged: 'litch/external/inboxChanged',
  outboxChanged: 'litch/external/outboxChanged',
} as const

export type ExternalProvider = 'github'
export type ExternalId = string
export type ExternalIssueId = Extract<ManagerIssueId, `X-${number}`>
export type ExternalRole = 'read' | 'triage' | 'write' | 'maintain' | 'admin'
export type ExternalEventKind =
  | 'issue'
  | 'pull_request'
  | 'comment'
  | 'review'
  | 'review_comment'
  | 'assigned'
  | 'unassigned'
  | 'review_requested'
  | 'review_request_removed'
  | 'labeled'
  | 'unlabeled'
  | 'closed'
  | 'merged'
  | 'reopened'
  | 'ci'
export interface ExternalSubject {
  provider: ExternalProvider
  repoId: ExternalId
  number: ExternalId
  kind: 'issue' | 'pull_request'
  url: string
}
export function externalSubjectKey(
  subject: Pick<ExternalSubject, 'provider' | 'repoId' | 'number'>,
): string {
  return `${subject.provider}/${subject.repoId}/${subject.number}`
}
export interface ExternalEvent {
  provider: ExternalProvider
  externalEventKey: string
  subjectKey: string
  kind: ExternalEventKind
  occurredAt: number
  actorEvidence: { userId: ExternalId; login?: string } | null
  targetEvidence: {
    subject: ExternalSubject
    sourceEventId: ExternalId
    assigneeUserId?: ExternalId
    reviewerUserId?: ExternalId
    labelId?: ExternalId
    labelIds?: ExternalId[]
    mentionsBot?: boolean
    publication?: 'published' | 'edited'
    mentionedBotId?: ExternalId
    labelName?: string
    run?: {
      runId: ExternalId
      attempt: number
      headSha: string
      workflowId: ExternalId
      status: string
      conclusion: string | null
    }
  }
  contentVersion: string | null
  permalink: string
}

export interface ExternalOwnerIdentity {
  provider: ExternalProvider
  userId: ExternalId
  loginCache: string
  profileUrl: string
  method: 'profileUrl' | 'userId' | 'localGh'
}
export interface ExternalOwner extends ExternalOwnerIdentity {
  configuredBy: string
  revision: number
}
export interface ExternalCredential {
  credentialRef: string
  provider: ExternalProvider
  botUserId: ExternalId
  resourceOwnerId: ExternalId
  createdAt: number
  expiresAt?: number
  lastVerifiedAt: number
  state: 'active' | 'invalid' | 'revoked'
  generation: number
}
export interface ExternalRepo {
  repoId: ExternalId
  owner: string
  name: string
  url: string
  localRoot: string
  allowedBase: string[]
  headNamespace: string
}
export interface ExternalRoute {
  routeId: string
  stableManagerId: string
  priority: number
  repoIds: ExternalId[]
  labelIds?: ExternalId[]
  eventKinds?: ExternalEventKind[]
  enabled: boolean
}
export interface ExternalSourceDraft {
  sourceId: string
  provider: ExternalProvider
  enabled: boolean
  credentialRef: string
  botUserId: ExternalId
  triggers: {
    mention: boolean
    assignment: boolean
    reviewRequest: boolean
    label: boolean
    labelIds: ExternalId[]
  }
  minRole: Exclude<ExternalRole, 'read'>
  writePolicy: { comment: boolean; draftPr: boolean; status: boolean; managedPush: boolean }
  interval: number
  repos: ExternalRepo[]
  routes: ExternalRoute[]
}
export interface ExternalSource extends ExternalSourceDraft {
  revision: number
  rulesVersion: number
  createdAt: number
}
export interface ExternalCoverage {
  repoId: ExternalId
  stream: string
  coveredThrough: number | null
  checkedAt?: number
  backoffUntil?: number
  gap?: { from: number; to: number; reason: string }
}
export interface ExternalSourceStatus {
  source: ExternalSource
  coverage: ExternalCoverage[]
}
export interface ExternalDiagnostic {
  check: string
  state: 'ok' | 'blocked' | 'unverified'
  code: string
  checkedAt?: number
}

export type ExternalInboxStatus =
  | 'received'
  | 'blocked'
  | 'pending_triage'
  | 'processed'
  | 'notified'
export interface ExternalInboxEvent {
  seq: number
  eventKey: string
  sourceId: string
  subjectKey: string
  subject: ExternalSubject
  kind: ExternalEventKind
  sourceEventId: ExternalId
  actorId: ExternalId | null
  actorRoleAtCheck: ExternalRole | 'owner' | null
  occurredAt: number
  observedAt: number
  ruleId?: string
  rulesVersion?: number
  routeId?: string
  managerId?: string
  issueId?: ExternalIssueId
  intakeId?: string
  reason?: string
  status: ExternalInboxStatus
  eventUrl: string
  contentVersion: string | null
  revision: number
}
export interface ExternalIntake {
  intakeId: string
  sourceId: string
  subjectKey: string
  subject: ExternalSubject
  managerId?: string
  issueId?: ExternalIssueId
  eventKeys: string[]
  autoNotifyUntil: number
  deliveryId?: string
  reason?: string
  status: 'pending_triage' | 'processed'
  revision: number
}
export interface ExternalRef extends ExternalSubject {
  managerId: string
  issueId: ExternalIssueId
  origin: 'intake' | 'write_receipt' | 'manual'
  createdAt: number
}
export type ExternalWriteAction = 'comment' | 'draft_pr' | 'status' | 'managed_push'
export interface ExternalAuthorizedScope {
  repoId: ExternalId
  subjectKey: string
  actions: ExternalWriteAction[]
}
export interface ExternalMandate {
  mandateId: string
  managerId: string
  issueId: ExternalIssueId
  subjectKey: string
  decision: 'accept' | 'merge'
  requesterUserId: ExternalId
  observedRole: ExternalRole | 'owner'
  eventKeys: string[]
  ruleId: string
  rulesVersion: number
  routeId: string
  acceptedBy: string
  acceptedAt: number
  authorizedScope: ExternalAuthorizedScope
  policyRevision: number
  revokedAt?: number
}
export interface ExternalAnswerSource {
  kind: 'github'
  repoId: ExternalId
  commentId: ExternalId
  actorUserId: ExternalId
  url: string
  revision: string
}
export interface ExternalWriteReceipt {
  objectId: ExternalId
  url: string
  at: number
  requestId?: string
  botUserId: ExternalId
  verifiedBy: 'response' | 'lookup' | 'manual'
}
export type ExternalWriteState =
  | 'queued'
  | 'sending'
  | 'confirmed'
  | 'unknown'
  | 'failed'
  | 'blocked'
  | 'canceled'
export interface ExternalOutboxSummary {
  seq: number
  operationId: string
  sourceId: string
  managerId: string
  issueId?: ExternalIssueId
  targetRef: ExternalSubject
  action: ExternalWriteAction
  state: ExternalWriteState
  revision: number
  attempts: number
  nextAttempt?: number
  receipt?: ExternalWriteReceipt
  errorClass?: string
}
export interface ExternalPageQuery {
  beforeSeq?: number
  limit?: number
}
export interface ExternalPage<T> {
  entries: T[]
  nextBeforeSeq: number | null
}
export interface ExternalInboxQuery extends ExternalPageQuery {
  sourceId?: string
  managerId?: string
  repoId?: ExternalId
  reason?: string
  status?: ExternalInboxStatus
}
export interface ExternalOutboxQuery extends ExternalPageQuery {
  sourceId?: string
  managerId?: string
  repoId?: ExternalId
  state?: ExternalWriteState
}
export type ExternalTriageAction =
  | {
      action: 'accept'
      title: string
      body: string
      relatedIssueId?: ExternalIssueId
      reply?: string
    }
  | { action: 'merge'; issueId: ExternalIssueId; expectedIssueRevision: number; reply?: string }
  | { action: 'ignore'; reason: string; reply?: string }
  | { action: 'reassign'; managerId: string }
export type ExternalTriageParams = ExternalTriageAction & {
  intakeId: string
  expectedRevision: number
  idempotencyKey: string
}
export type ExternalTriageResult =
  | {
      outcome: 'applied'
      intake: ExternalIntake
      ref?: ExternalRef
      mandate?: ExternalMandate
      reply?: { operationId: string } | { notQueued: string }
    }
  | {
      outcome: 'conflict'
      reason: 'intake_revision' | 'issue_revision' | 'binding' | 'idempotency'
      intake: ExternalIntake
      ref?: ExternalRef
    }

interface RevisionParams {
  operationId: string
  expectedRevision: number
}
export interface ExternalSourceMutationParams extends RevisionParams {
  sourceId: string
}
interface ExternalCredentialConfigureParams {
  operationId: string
  token: string
  repoIds: ExternalId[]
}
interface ExternalCredentialMutationParams {
  operationId: string
  credentialRef: string
  expectedGeneration: number
}
type Empty = Record<string, never>
type Request<P, R> = { params: P; result: R }
export interface ExternalRequests {
  [EXTERNAL_METHOD.ownerGet]: Request<Empty, { owner: ExternalOwner | null }>
  [EXTERNAL_METHOD.ownerSet]: Request<
    RevisionParams & { owner: ExternalOwnerIdentity },
    { owner: ExternalOwner }
  >
  [EXTERNAL_METHOD.credentialConfigure]: Request<
    ExternalCredentialConfigureParams,
    { credential: ExternalCredential }
  >
  [EXTERNAL_METHOD.credentialRotate]: Request<
    ExternalCredentialMutationParams & { token: string },
    { credential: ExternalCredential }
  >
  [EXTERNAL_METHOD.credentialRevoke]: Request<
    ExternalCredentialMutationParams,
    { credential: ExternalCredential }
  >
  [EXTERNAL_METHOD.sourceList]: Request<Empty, { sources: ExternalSourceStatus[] }>
  [EXTERNAL_METHOD.sourceGet]: Request<{ sourceId: string }, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceUpsert]: Request<
    RevisionParams & { source: ExternalSourceDraft },
    ExternalSourceStatus
  >
  [EXTERNAL_METHOD.sourcePreview]: Request<
    { source: ExternalSourceDraft },
    { matches: Omit<ExternalInboxEvent, 'seq' | 'revision'>[]; diagnostics: ExternalDiagnostic[] }
  >
  [EXTERNAL_METHOD.sourcePause]: Request<ExternalSourceMutationParams, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceResume]: Request<ExternalSourceMutationParams, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceCheck]: Request<
    { sourceId: string },
    { diagnostics: ExternalDiagnostic[] }
  >
  [EXTERNAL_METHOD.inboxList]: Request<ExternalInboxQuery, ExternalPage<ExternalInboxEvent>>
  [EXTERNAL_METHOD.inboxGet]: Request<
    { eventKey: string } | { intakeId: string },
    { events: ExternalInboxEvent[]; intake: ExternalIntake | null }
  >
  [EXTERNAL_METHOD.inboxTriage]: Request<ExternalTriageParams, ExternalTriageResult>
  [EXTERNAL_METHOD.outboxList]: Request<ExternalOutboxQuery, ExternalPage<ExternalOutboxSummary>>
  [EXTERNAL_METHOD.outboxGet]: Request<{ operationId: string }, ExternalOutboxSummary>
  [EXTERNAL_METHOD.outboxReconcile]: Request<
    { operationId: string },
    { receipt: ExternalWriteReceipt | null; diagnostics: ExternalDiagnostic[] }
  >
  [EXTERNAL_METHOD.outboxCancel]: Request<
    RevisionParams & { targetOperationId: string },
    ExternalOutboxSummary
  >
}
export interface ExternalNotifications {
  [EXTERNAL_NOTIFICATION.sourcesChanged]: { sourceId: string; revision: number }
  [EXTERNAL_NOTIFICATION.inboxChanged]: {
    sourceId: string
    managerId?: string
    revision: number
    pending: number
  }
  [EXTERNAL_NOTIFICATION.outboxChanged]: {
    sourceId: string
    managerId: string
    revision: number
    pending: number
  }
}

export interface ExternalIssueFields {
  externalRefs?: ExternalRef[]
  intakeMandates?: ExternalMandate[]
}

// 在实际出站连接上调用。含看板变更快照、决策答复和议题详情的包裹对象都适用。
export function projectExternalManagerPayload<T>(value: T, declared: ReadonlySet<string>): T {
  const external = declared.has(EXTERNAL_SOURCES_EXTENSION)
  const issues = external && declared.has('litchManagerIssues')
  const answers = external && declared.has('litchManager')
  if (issues && answers) return value
  const hidden = new Set([
    ...(!issues ? ['externalRefs', 'intakeMandates'] : []),
    ...(!answers ? ['answerSource'] : []),
  ])
  const project = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(project)
    if (!input || typeof input !== 'object') return input
    const entries = Object.entries(input).filter(([key]) => !hidden.has(key))
    return Object.fromEntries(
      entries.map(([key, field]) => [
        key,
        key === 'fields' && Array.isArray(field)
          ? field.filter((name) => !hidden.has(name)).map(project)
          : project(field),
      ]),
    )
  }
  return project(value) as T
}

export const EXTERNAL_ANSWER_SAMPLE = {
  kind: 'github',
  repoId: '9007199254740993',
  commentId: '2',
  actorUserId: '3',
  url: 'https://github.com/example/repo/issues/1#issuecomment-2',
  revision: 'sha256:example',
} satisfies ExternalAnswerSource
export const EXTERNAL_ANSWER_PROJECTION_SAMPLE = {
  optionId: null,
  text: '照办',
  by: 'user-conversation',
  at: 1,
  answerSource: EXTERNAL_ANSWER_SAMPLE,
} satisfies ManagerAnswer
