// 设备与核心共用的入站形状校验。GitHub 身份、写入和路由授权仍由设备核验。
import {
  EXTERNAL_IDENTITY_OPTIONAL_SCOPES,
  EXTERNAL_IDENTITY_REQUIRED_SCOPES,
  EXTERNAL_METHOD,
  type ExternalAnswerSource,
  type ExternalEvent,
  type ExternalRequests,
} from './external-sources.mjs'

type Check = (value: unknown) => boolean
const str =
  (max = 256, min = 1): Check =>
  (value) =>
    typeof value === 'string' && [...value].length >= min && [...value].length <= max
const int =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const exact =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value)
const pattern =
  (regex: RegExp): Check =>
  (value) =>
    typeof value === 'string' && regex.test(value)
const array =
  (item: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(item)
const either =
  (...checks: Check[]): Check =>
  (value) =>
    checks.filter((check) => check(value)).length === 1

function obj(required: Record<string, Check> = {}, optional: Record<string, Check> = {}): Check {
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const fields = value as Record<string, unknown>
    return (
      Object.entries(required).every(
        ([key, check]) => Object.hasOwn(fields, key) && check(fields[key]),
      ) &&
      Object.entries(fields).every(
        ([key, field]) =>
          Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]?.(field)),
      )
    )
  }
}

const s = str()
const operationId = str(128)
const token = str(4096)
const id = pattern(/^[1-9][0-9]*$/)
const issueId = pattern(/^X-[1-9][0-9]*$/)
const url = pattern(/^https:\/\/github\.com\/[^\s]+$/)
const bool: Check = (value) => typeof value === 'boolean'
const revision = int(1)
const mutation = { operationId, expectedRevision: int() }
const credential = { operationId, credentialRef: s, expectedGeneration: revision }
const sourceId = { sourceId: s }
const owner = obj({
  provider: exact('github'),
  userId: id,
  loginCache: s,
  profileUrl: url,
  method: exact('profileUrl', 'userId', 'localGh'),
})
const eventKind = exact(
  'issue',
  'pull_request',
  'comment',
  'review',
  'review_comment',
  'assigned',
  'unassigned',
  'review_requested',
  'review_request_removed',
  'labeled',
  'unlabeled',
  'closed',
  'merged',
  'reopened',
  'ci',
)
const source = obj(
  {
    sourceId: s,
    provider: exact('github'),
    enabled: bool,
    credentialRef: s,
    botUserId: id,
    triggers: obj({
      mention: bool,
      assignment: bool,
      reviewRequest: bool,
      label: bool,
      labelIds: array(id),
    }),
    minRole: exact('triage', 'write', 'maintain', 'admin'),
    interval: int(1),
    writePolicy: obj(
      { comment: bool, draftPr: bool, status: bool, managedPush: bool },
      { statusGateConfirmed: bool },
    ),
    repos: array(
      obj(
        {
          repoId: id,
          owner: s,
          name: s,
          url,
          localRoot: s,
          allowedBase: array(s),
          headNamespace: s,
        },
        {
          pollIdentity: (value) => value === null || s(value),
          labelRoutes: array(obj({ labelId: id, managerId: s })),
          immediateFeedback: bool,
          immediateFeedbackLanguage: exact('follow-ui', 'zh-CN', 'en'),
        },
      ),
    ),
    routes: array(
      obj(
        {
          routeId: s,
          stableManagerId: s,
          priority: int(Number.MIN_SAFE_INTEGER),
          repoIds: array(id),
          enabled: bool,
        },
        {
          labelIds: array(id),
          eventKinds: array(eventKind),
        },
      ),
    ),
  },
  { unattended: obj({ autoNotify: bool }, { autoLinkAgentPr: bool }) },
)
const query = { beforeSeq: int(1), limit: int(1, 100), ...sourceId, managerId: s, repoId: id }
const status = exact('received', 'blocked', 'pending_triage', 'processed', 'notified')
const statuses: Check = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 5 &&
  new Set(value).size === value.length &&
  value.every(status)
const triage = { intakeId: s, expectedRevision: revision, idempotencyKey: operationId }
const reply = str(65536)
const allScopes = [...EXTERNAL_IDENTITY_REQUIRED_SCOPES, ...EXTERNAL_IDENTITY_OPTIONAL_SCOPES]
const scopes: Check = (value) =>
  Array.isArray(value) &&
  new Set(value).size === value.length &&
  value.every(exact(...allScopes)) &&
  EXTERNAL_IDENTITY_REQUIRED_SCOPES.every((scope) => value.includes(scope))
const checks = {
  [EXTERNAL_METHOD.accessGet]: obj(),
  [EXTERNAL_METHOD.ownerGet]: obj(),
  [EXTERNAL_METHOD.ownerSet]: obj({ ...mutation, owner }),
  [EXTERNAL_METHOD.credentialConfigure]: obj({ operationId, token, repoIds: array(id) }),
  [EXTERNAL_METHOD.credentialRotate]: obj({ ...credential, token }),
  [EXTERNAL_METHOD.credentialRevoke]: obj(credential),
  [EXTERNAL_METHOD.identityList]: obj(),
  [EXTERNAL_METHOD.identityAdd]: obj({ operationId, scopes }),
  [EXTERNAL_METHOD.identityImport]: obj({ operationId }),
  [EXTERNAL_METHOD.identityPaste]: obj({ operationId, token }),
  [EXTERNAL_METHOD.identityLoginGet]: obj({ loginId: s }),
  [EXTERNAL_METHOD.identityLoginCancel]: obj({ loginId: s, operationId }),
  [EXTERNAL_METHOD.identityLoginConfirm]: obj({ ...mutation, loginId: s }),
  [EXTERNAL_METHOD.identityRotate]: obj({ ...credential, identityId: s, token }),
  [EXTERNAL_METHOD.identityRevoke]: obj({ ...credential, identityId: s }),
  [EXTERNAL_METHOD.identityRepositories]: obj(
    {},
    { identityId: s, repoId: id, cursor: str(2048), limit: int(1, 100) },
  ),
  [EXTERNAL_METHOD.configurationGet]: obj(),
  [EXTERNAL_METHOD.managerAssignmentGet]: obj({ managerId: s }),
  [EXTERNAL_METHOD.managerAssignmentSet]: obj(
    {
      ...mutation,
      managerId: s,
      identityId: (value) => value === null || s(value),
      repoIds: (value) =>
        Array.isArray(value) && new Set(value).size === value.length && value.every(id),
    },
    { injectCredentials: bool },
  ),
  [EXTERNAL_METHOD.sourceList]: obj(),
  [EXTERNAL_METHOD.sourceGet]: obj(sourceId),
  [EXTERNAL_METHOD.sourceUpsert]: obj({ ...mutation, source }),
  [EXTERNAL_METHOD.sourcePreview]: obj({ source }),
  [EXTERNAL_METHOD.sourcePause]: obj({ ...mutation, ...sourceId }),
  [EXTERNAL_METHOD.sourceResume]: obj({ ...mutation, ...sourceId }),
  [EXTERNAL_METHOD.sourceCheck]: obj(sourceId),
  [EXTERNAL_METHOD.inboxList]: either(
    obj({}, { ...query, status, reason: s }),
    obj({ statuses }, { ...query, reason: s }),
  ),
  [EXTERNAL_METHOD.inboxGet]: either(obj({ eventKey: s }), obj({ intakeId: s })),
  [EXTERNAL_METHOD.inboxTriage]: either(
    obj(
      { ...triage, action: exact('accept'), title: s, body: str(65536, 0) },
      { relatedIssueId: issueId, reply },
    ),
    obj({ ...triage, action: exact('merge'), issueId, expectedIssueRevision: revision }, { reply }),
    obj({ ...triage, action: exact('ignore'), reason: s }, { reply }),
    obj({ ...triage, action: exact('reassign'), managerId: s }),
  ),
  [EXTERNAL_METHOD.outboxList]: obj(
    {},
    {
      ...query,
      issueId,
      state: exact('queued', 'sending', 'confirmed', 'unknown', 'failed', 'blocked', 'canceled'),
    },
  ),
  [EXTERNAL_METHOD.outboxGet]: obj({ operationId }),
  [EXTERNAL_METHOD.outboxReconcile]: obj({ operationId }),
  [EXTERNAL_METHOD.outboxCancel]: obj({ ...mutation, targetOperationId: operationId }),
} satisfies { [M in keyof ExternalRequests]: Check }

export function isExternalMethod<M extends string>(
  method: M,
): method is M & keyof ExternalRequests {
  return Object.hasOwn(checks, method)
}

export function isExternalMethodParams<M extends keyof ExternalRequests>(
  method: M,
  params: unknown,
): params is ExternalRequests[M]['params'] {
  return checks[method](params)
}

const checkAnswerSource = obj({
  kind: exact('github'),
  repoId: id,
  commentId: id,
  actorUserId: id,
  url,
  revision: s,
})
export function isExternalAnswerSource(value: unknown): value is ExternalAnswerSource {
  return checkAnswerSource(value)
}

const subject = obj({
  provider: exact('github'),
  repoId: id,
  number: id,
  kind: exact('issue', 'pull_request'),
  url,
})
const nullOr =
  (check: Check): Check =>
  (value) =>
    value === null || check(value)
const event = obj({
  provider: exact('github'),
  externalEventKey: s,
  subjectKey: s,
  kind: eventKind,
  occurredAt: int(),
  actorEvidence: nullOr(obj({ userId: id }, { login: s })),
  targetEvidence: obj(
    { subject, sourceEventId: id },
    {
      assigneeUserId: id,
      reviewerUserId: id,
      labelId: id,
      labelIds: array(id),
      mentionsBot: bool,
      publication: exact('published', 'edited'),
      mentionedBotId: id,
      labelName: s,
      run: obj({
        runId: id,
        attempt: int(1),
        headSha: s,
        workflowId: id,
        status: s,
        conclusion: nullOr(s),
      }),
    },
  ),
  contentVersion: nullOr(s),
  permalink: url,
})
export function isExternalEvent(value: unknown): value is ExternalEvent {
  return event(value)
}
