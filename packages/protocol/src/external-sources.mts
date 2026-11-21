// 设备外部来源与收件箱。平台数字 ID 始终用十进制字符串，时间用 UTC epoch 秒。

import type { ManagerAnswer } from './manager.mjs'
import type { ManagerIssueId } from './manager-issues.mjs'

export const EXTERNAL_SOURCES_EXTENSION = 'litchExternalSources'
export const EXTERNAL_METHOD = {
  accessGet: 'litch/external/access/get',
  ownerGet: 'litch/external/owner/get',
  ownerSet: 'litch/external/owner/set',
  credentialConfigure: 'litch/external/credential/configure',
  credentialRotate: 'litch/external/credential/rotate',
  credentialRevoke: 'litch/external/credential/revoke',
  identityList: 'litch/external/identities/list',
  identityAdd: 'litch/external/identities/add',
  identityImport: 'litch/external/identities/import',
  identityPaste: 'litch/external/identities/paste',
  identityLoginGet: 'litch/external/identities/login/get',
  identityLoginCancel: 'litch/external/identities/login/cancel',
  identityLoginConfirm: 'litch/external/identities/login/confirm',
  identityRotate: 'litch/external/identities/rotate',
  identityRevoke: 'litch/external/identities/revoke',
  identityRepositories: 'litch/external/identities/repositories',
  configurationGet: 'litch/external/configuration/get',
  managerAssignmentGet: 'litch/external/manager/assignment/get',
  managerAssignmentSet: 'litch/external/manager/assignment/set',
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
  accessChanged: 'litch/external/accessChanged',
  identityLoginChanged: 'litch/external/identities/login/changed',
  configurationChanged: 'litch/external/configurationChanged',
  ownerChanged: 'litch/external/ownerChanged',
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
  /** OAuth 的资源所有者 ID 是账本键，不表示访问范围。 */
  resourceOwnerId: ExternalId
  credentialKind?: 'oauth' | 'fine_grained'
  scopes?: string[]
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
  /** null 或省略时，设备从有读取权限的身份中选择。 */
  pollIdentity?: string | null
  labelRoutes?: ExternalLabelRoute[]
  /** 缺省开启；文案语言缺省跟随 Litch。 */
  immediateFeedback?: boolean
  immediateFeedbackLanguage?: 'follow-ui' | 'zh-CN' | 'en'
}
export interface ExternalResolvedRepo {
  repoId: ExternalId
  owner: string
  name: string
  url: string
  defaultBranch: string
  defaultLabelId?: ExternalId
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
  writePolicy: {
    comment: boolean
    draftPr: boolean
    status: boolean
    managedPush: boolean
    /** 设备管理员确认 litch/progress 未作为合并门禁。 */
    statusGateConfirmed?: boolean
  }
  interval: number
  repos: ExternalRepo[]
  routes: ExternalRoute[]
  /** 自动提醒默认关。经理的凭据注入由经理分配决定。 */
  unattended?: { autoNotify: boolean; autoLinkAgentPr?: boolean }
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
  runtime?: {
    state: 'collecting' | 'paused' | 'backoff' | 'blocked'
    lastAttemptAt?: number
    lastSuccessAt?: number
    nextAttemptAt?: number
    credentialState?: ExternalCredential['state']
    backlog: { pending: number; limited: number; oldestAt?: number; nextWakeAt?: number }
  }
  readiness?: ExternalReadiness
  agentGhIdentity?: ExternalAgentGhIdentity
}
export interface ExternalManagerRecovery {
  managerId: string
  threadId: string
  action: 'refresh' | 'replace'
}

export interface ExternalDiagnostic {
  check: string
  state: 'ok' | 'blocked' | 'unverified'
  code: string
  checkedAt?: number
  recovery?: ExternalManagerRecovery
}
export interface ExternalIdentityHead {
  identityId: string
  botUserId: ExternalId
  login: string
}
export interface ExternalIdentity extends ExternalIdentityHead {
  revision: number
  /** 同一个机器人账号可以持有多个资源所有者的凭据。 */
  credentials: ExternalCredential[]
}
// 当前随附的官方 GitHub CLI 登录自动申请这三项；客户端必须事先告知。
export const EXTERNAL_IDENTITY_REQUIRED_SCOPES = ['repo', 'read:org', 'gist'] as const
export const EXTERNAL_IDENTITY_OPTIONAL_SCOPES = [
  'notifications',
  'workflow',
  'read:packages',
  'write:packages',
] as const
export type ExternalIdentityScope =
  | (typeof EXTERNAL_IDENTITY_REQUIRED_SCOPES)[number]
  | (typeof EXTERNAL_IDENTITY_OPTIONAL_SCOPES)[number]
export const EXTERNAL_IDENTITY_VERIFICATION_URL = 'https://github.com/login/device'
export interface ExternalIdentityAuthorization {
  account: { login: string; userId: ExternalId; name?: string; avatarUrl?: string }
  scopes: string[]
  repositories: ExternalResolvedRepo[]
  repositoriesTruncated?: boolean
  isOwner: boolean
  /** owner 显式确认前不持久化及返回身份。 */
  identity?: ExternalIdentity
}
export type ExternalIdentityLogin = {
  loginId: string
  revision: number
  expiresAt: number
} & (
  | { state: 'preparing'; phase: 'download' | 'device_code' }
  | {
      state: 'waiting'
      userCode: string
      verificationUrl: typeof EXTERNAL_IDENTITY_VERIFICATION_URL
    }
  | { state: 'succeeded'; needsConfirmation: boolean; result: ExternalIdentityAuthorization }
  | { state: 'canceled' | 'timed_out' | 'expired' }
  | { state: 'error'; code: string }
)

export function isGithubCliSetupFailure(code: string): boolean {
  return /^github_gh_(?:download_|install_|version_|platform_unsupported)/.test(code)
}
export interface ExternalIdentityRepository extends ExternalResolvedRepo {
  grants: {
    identityId: string
    botUserId: ExternalId
    credentialRef: string
    read: boolean
    write: 'verified' | 'missing' | 'unverified'
  }[]
}
export interface ExternalLabelRoute {
  labelId: ExternalId
  managerId: string
}
export interface ExternalManagerAssignment {
  managerId: string
  identityId: string | null
  repoIds: ExternalId[]
  /** 默认 true；停用注入不改变寻址。 */
  injectCredentials?: boolean
  revision: number
}
export interface ExternalConfiguration {
  /** 每次身份可用集合、仓库或经理分配变化后递增；整份同版本读取。 */
  revision: number
  identities: ExternalIdentityHead[]
  repositories: {
    repoId: ExternalId
    pollIdentity: string | null
    labelRoutes: ExternalLabelRoute[]
    immediateFeedback?: boolean
    immediateFeedbackLanguage?: ExternalRepo['immediateFeedbackLanguage']
  }[]
  assignments: ExternalManagerAssignment[]
}
export interface ExternalAgentGhIdentity {
  userId: ExternalId
  login: string
  /** 由设备和当前配置的 owner 数字 ID 比较。 */
  isOwner: boolean
  checkedAt: number
}
export type ExternalReadinessArea = 'collect' | 'notify' | 'dispatch' | 'write'
export type ExternalReadiness = Record<
  ExternalReadinessArea,
  { state: ExternalDiagnostic['state']; diagnostics: ExternalDiagnostic[] }
>

export type ExternalInboxStatus =
  | 'received'
  | 'blocked'
  | 'pending_triage'
  | 'processed'
  | 'notified'
/** 只对当前连接生效。缺省或 false 都不授权，写请求仍由设备复核。 */
export interface ExternalAccess {
  configure?: boolean
  configureAutostart?: boolean
  pauseSource?: boolean
  resumeSource?: boolean
  triageInbox?: boolean
  reassignInbox?: boolean
}
/** 投递进经理回合才算 confirmed；不改变候选的分拣状态。 */
export interface ExternalInboxDelivery {
  state: 'queued' | 'sending' | 'confirmed' | 'unknown' | 'blocked'
  reason?: string
  recovery?: ExternalManagerRecovery
}
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
  delivery?: ExternalInboxDelivery
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
export type ExternalManagerWriteAction = 'comment' | 'draft_pr' | 'status' | 'managed_push'
/** 三种即时反馈动作只允许设备内部入队，不开放给经理的 external_write。 */
export type ExternalFeedbackAction = 'ack_comment_create' | 'ack_comment_update' | 'reaction_add'
export type ExternalWriteAction = ExternalManagerWriteAction | ExternalFeedbackAction
export interface ExternalAuthorizedScope {
  repoId: ExternalId
  subjectKey: string
  actions: ExternalManagerWriteAction[]
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
  /** 与 status 互斥；服务端统一排序和分页。 */
  statuses?: ExternalInboxStatus[]
}
export interface ExternalOutboxQuery extends ExternalPageQuery {
  issueId?: ExternalIssueId
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
  [EXTERNAL_METHOD.accessGet]: Request<Empty, ExternalAccess>
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
  [EXTERNAL_METHOD.identityList]: Request<Empty, { identities: ExternalIdentity[] }>
  [EXTERNAL_METHOD.identityAdd]: Request<
    { operationId: string; scopes: ExternalIdentityScope[] },
    ExternalIdentityLogin
  >
  [EXTERNAL_METHOD.identityImport]: Request<{ operationId: string }, ExternalIdentityLogin>
  [EXTERNAL_METHOD.identityPaste]: Request<
    { operationId: string; token: string },
    ExternalIdentityLogin
  >
  [EXTERNAL_METHOD.identityLoginGet]: Request<{ loginId: string }, ExternalIdentityLogin>
  [EXTERNAL_METHOD.identityLoginCancel]: Request<
    { loginId: string; operationId: string },
    ExternalIdentityLogin
  >
  [EXTERNAL_METHOD.identityLoginConfirm]: Request<
    RevisionParams & { loginId: string },
    ExternalIdentityLogin
  >
  [EXTERNAL_METHOD.identityRotate]: Request<
    ExternalCredentialMutationParams & { identityId: string; token: string },
    { identity: ExternalIdentity }
  >
  [EXTERNAL_METHOD.identityRevoke]: Request<
    ExternalCredentialMutationParams & { identityId: string },
    { identity: ExternalIdentity }
  >
  [EXTERNAL_METHOD.identityRepositories]: Request<
    { identityId?: string; repoId?: ExternalId; cursor?: string; limit?: number },
    { repositories: ExternalIdentityRepository[]; nextCursor: string | null }
  >
  [EXTERNAL_METHOD.configurationGet]: Request<Empty, ExternalConfiguration>
  [EXTERNAL_METHOD.managerAssignmentGet]: Request<{ managerId: string }, ExternalManagerAssignment>
  [EXTERNAL_METHOD.managerAssignmentSet]: Request<
    RevisionParams & Omit<ExternalManagerAssignment, 'revision'>,
    ExternalManagerAssignment
  >
  [EXTERNAL_METHOD.sourceList]: Request<Empty, { sources: ExternalSourceStatus[] }>
  [EXTERNAL_METHOD.sourceGet]: Request<{ sourceId: string }, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceUpsert]: Request<
    RevisionParams & { source: ExternalSourceDraft },
    ExternalSourceStatus
  >
  [EXTERNAL_METHOD.sourcePreview]: Request<
    { source: ExternalSourceDraft },
    {
      matches: Omit<ExternalInboxEvent, 'seq' | 'revision' | 'delivery'>[]
      diagnostics: ExternalDiagnostic[]
    }
  >
  [EXTERNAL_METHOD.sourcePause]: Request<ExternalSourceMutationParams, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceResume]: Request<ExternalSourceMutationParams, ExternalSourceStatus>
  [EXTERNAL_METHOD.sourceCheck]: Request<
    { sourceId: string },
    {
      diagnostics: ExternalDiagnostic[]
      readiness?: ExternalReadiness
      agentGhIdentity?: ExternalAgentGhIdentity
    }
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
  [EXTERNAL_NOTIFICATION.accessChanged]: Empty
  [EXTERNAL_NOTIFICATION.identityLoginChanged]: { loginId: string; revision: number }
  [EXTERNAL_NOTIFICATION.configurationChanged]: { revision: number }
  [EXTERNAL_NOTIFICATION.ownerChanged]: { revision: number }
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
