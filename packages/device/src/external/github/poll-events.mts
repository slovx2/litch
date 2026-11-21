import type { GithubRunKey, GithubRunSnapshot } from './actions.mjs'
import { validGithubSha } from './actions.mjs'
import { type GithubActorEvidence, githubActor, mentionsGithubLogin } from './identity.mjs'
import type {
  GithubActionStub,
  GithubContentCandidate,
  GithubIssueAction,
  GithubObjectObservation,
  GithubPollEvent,
  GithubPullCandidate,
  GithubPullObservation,
  GithubSubjectKind,
  GithubSubjectObservation,
  GithubTargetEvidence,
} from './poll-state.mjs'
import {
  GithubFault,
  type GithubRepository,
  githubId,
  githubNumber,
  githubObject,
  githubPermalink,
  githubSubjectNumber,
  githubTime,
  type JsonObject,
} from './read-api.mjs'
import {
  type GithubContentKind,
  githubBody,
  githubContentAnchor,
  githubContentHash,
  githubContentTimes,
  githubContentVersion,
} from './read-content.mjs'

export function requiredId(value: unknown): string {
  const id = githubId(value)
  if (!id) throw new GithubFault('invalid-response')
  return id
}

export function requiredNumber(value: unknown): number {
  const number = githubNumber(value)
  if (!number) throw new GithubFault('invalid-response')
  return number
}

export function requiredTime(value: unknown): number {
  const time = githubTime(value)
  if (time === undefined) throw new GithubFault('invalid-response')
  return time
}

export function subjectKind(raw: JsonObject): GithubSubjectKind {
  return raw.pull_request ? 'pull' : 'issue'
}

export function githubSubjectObservation(
  raw: JsonObject,
  repo: GithubRepository,
  kind: GithubSubjectKind,
): GithubSubjectObservation {
  if (raw.state !== 'open' && raw.state !== 'closed') throw new GithubFault('invalid-response')
  const merged = kind === 'pull' && raw.merged_at != null
  if (merged) requiredTime(raw.merged_at)
  return {
    subject: eventTarget(repo, requiredNumber(raw.number), kind, requiredId(raw.id)).subject,
    state: merged ? 'merged' : raw.state,
    updatedAt: requiredTime(raw.updated_at),
  }
}

function eventTarget(
  repo: GithubRepository,
  number: number,
  kind: GithubSubjectKind,
  sourceEventId: string,
): GithubTargetEvidence {
  return {
    sourceEventId,
    subject: {
      provider: 'github',
      repoId: repo.repoId,
      number: String(number),
      kind: kind === 'pull' ? 'pull_request' : 'issue',
      url: githubPermalink(repo, `${kind === 'pull' ? 'pull' : 'issues'}/${number}`),
    },
  }
}

function makeEvent(
  kind: GithubPollEvent['kind'],
  externalEventKey: string,
  occurredAt: number,
  actorEvidence: GithubActorEvidence | null,
  targetEvidence: GithubTargetEvidence,
  permalink: string,
  contentVersion: string | null = null,
): GithubPollEvent {
  return {
    provider: 'github',
    externalEventKey: `github/${targetEvidence.subject.repoId}/${externalEventKey}`,
    kind,
    subjectKey: `github/${targetEvidence.subject.repoId}/${targetEvidence.subject.number}`,
    occurredAt: Math.floor(occurredAt / 1000),
    actorEvidence,
    targetEvidence,
    contentVersion,
    permalink,
  }
}

export function githubContentCandidate(
  raw: JsonObject,
  kind: GithubContentKind,
  number: number,
  bot: GithubActorEvidence,
): GithubContentCandidate {
  const objectId = requiredId(raw.id)
  const { created, updated } = githubContentTimes(raw, kind)
  const body = githubBody(raw)
  return {
    kind,
    number,
    objectId,
    objectKey: `${number}/${kind}/${objectId}`,
    createdAt: created,
    updatedAt: updated,
    hash: githubContentHash(body),
    mentioned: mentionsGithubLogin(body, bot.login),
    actor: githubActor(raw.user) ?? null,
  }
}

const contentEventKind = {
  issue: 'issue',
  pull: 'pull_request',
  'issue-comment': 'comment',
  'review-comment': 'review_comment',
  review: 'review',
} as const

export function githubContentChange(
  candidate: GithubContentCandidate,
  previous: GithubObjectObservation | undefined,
  repo: GithubRepository,
  kind: GithubSubjectKind,
  botId: string,
  enabledAt: number,
  scanTo: number,
  observedAt: number,
): { observation?: GithubObjectObservation; event?: GithubPollEvent } {
  const { objectKey, updatedAt, hash, mentioned } = candidate
  if (previous && previous.updatedAt > updatedAt) return {}
  const observation = {
    objectKey,
    subjectKey: `github/${repo.repoId}/${candidate.number}`,
    objectId: candidate.objectId,
    observedAt,
    updatedAt,
    hash,
    mentioned,
  }
  if (previous && previous.hash === hash && previous.mentioned === mentioned) return { observation }
  // 首次看到的更新时间晚于创建时间时，不能证明目前的正文是作者提交的原文。
  // 已登记的原文证明由复核用创建时间和摘要比对；此处不把晚发现的提及补记为原文。
  const publication = !previous && candidate.createdAt === updatedAt ? 'published' : 'edited'
  // 无编辑时间的 review，只能用首次发现新摘要的时间记录编辑，绝不再次当作提交。
  const at =
    publication === 'edited' && candidate.kind === 'review' && previous?.updatedAt === updatedAt
      ? scanTo
      : updatedAt
  if (at < enabledAt) return { observation }
  const target: GithubTargetEvidence = {
    ...eventTarget(repo, candidate.number, kind, candidate.objectId),
    publication,
    mentionsBot: mentioned,
    ...(mentioned ? { mentionedBotId: botId } : {}),
  }
  const version = githubContentVersion(updatedAt, hash)
  return {
    observation,
    event: makeEvent(
      contentEventKind[candidate.kind],
      `content/${objectKey}/${version}`,
      at,
      candidate.actor,
      target,
      target.subject.url + githubContentAnchor(candidate.kind, candidate.objectId),
      version,
    ),
  }
}

const actions: ReadonlySet<string> = new Set<GithubIssueAction>([
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'review_requested',
  'review_request_removed',
  'closed',
  'reopened',
])

export function githubActionType(raw: JsonObject): GithubIssueAction | undefined {
  return typeof raw.event === 'string' && actions.has(raw.event)
    ? (raw.event as GithubIssueAction)
    : undefined
}

export function githubActionStub(raw: JsonObject, action: GithubIssueAction): GithubActionStub {
  const has = (field: string) => raw[field] !== null && raw[field] !== undefined
  const actor = githubActor(
    action === 'assigned' || action === 'unassigned'
      ? has('assigner')
        ? raw.assigner
        : raw.actor
      : action === 'review_requested' || action === 'review_request_removed'
        ? has('review_requester')
          ? raw.review_requester
          : raw.actor
        : raw.actor,
  )
  const assigneeId = githubId(githubObject(raw.assignee).id)
  const reviewerId = githubId(githubObject(raw.requested_reviewer).id)
  const label = githubObject(raw.label)
  const labelId = githubId(label.id)
  const labelName =
    typeof label.name === 'string' && label.name.length > 0 && label.name.length <= 128
      ? label.name
      : undefined
  return {
    id: requiredId(raw.id),
    action,
    at: requiredTime(raw.created_at),
    ...(actor ? { actor } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(reviewerId ? { reviewerId } : {}),
    ...(labelId ? { labelId } : {}),
    ...(labelName ? { labelName } : {}),
  }
}

export function githubVerifiedAction(
  repo: GithubRepository,
  number: number,
  kind: GithubSubjectKind,
  expected: GithubActionStub,
  actual: GithubActionStub,
): GithubPollEvent | undefined {
  if (
    actual.id !== expected.id ||
    actual.action !== expected.action ||
    actual.at !== expected.at ||
    (expected.actor && actual.actor && expected.actor.userId !== actual.actor.userId) ||
    (expected.labelId && actual.labelId && expected.labelId !== actual.labelId) ||
    (expected.labelName && actual.labelName && expected.labelName !== actual.labelName) ||
    (expected.assigneeId && actual.assigneeId && expected.assigneeId !== actual.assigneeId) ||
    (expected.reviewerId && actual.reviewerId && expected.reviewerId !== actual.reviewerId)
  )
    return
  const actor = actual.actor ?? expected.actor
  const assigneeId = actual.assigneeId ?? expected.assigneeId
  const reviewerId = actual.reviewerId ?? expected.reviewerId
  const labelId = actual.labelId ?? expected.labelId
  const labelName = actual.labelName ?? expected.labelName
  if (
    !actor ||
    ((actual.action === 'labeled' || actual.action === 'unlabeled') && !labelName && !labelId) ||
    ((actual.action === 'assigned' || actual.action === 'unassigned') && !assigneeId) ||
    ((actual.action === 'review_requested' || actual.action === 'review_request_removed') &&
      !reviewerId)
  )
    return
  const target: GithubTargetEvidence = {
    ...eventTarget(repo, number, kind, actual.id),
    ...(assigneeId ? { assigneeUserId: assigneeId } : {}),
    ...(reviewerId ? { reviewerUserId: reviewerId } : {}),
    ...(labelId ? { labelId } : {}),
    ...(labelName ? { labelName } : {}),
  }
  return makeEvent(
    actual.action,
    `issue-event/${actual.id}`,
    actual.at,
    actor,
    target,
    `${target.subject.url}#event-${actual.id}`,
  )
}

export function githubCommentNumber(
  raw: JsonObject,
  repo: GithubRepository,
  kind: 'issue-comment' | 'review-comment',
): number {
  const number =
    kind === 'issue-comment'
      ? githubSubjectNumber(raw.issue_url, repo, 'issues')
      : githubSubjectNumber(raw.pull_request_url, repo, 'pulls')
  return requiredNumber(number)
}

export function githubCommentParent(
  candidate: GithubContentCandidate,
  raw: JsonObject,
  repo: GithubRepository,
): GithubSubjectKind | undefined {
  const anchor = githubContentAnchor('issue-comment', candidate.objectId)
  if (raw.html_url === githubPermalink(repo, `issues/${candidate.number}${anchor}`)) return 'issue'
  if (raw.html_url === githubPermalink(repo, `pull/${candidate.number}${anchor}`)) return 'pull'
}

export function githubPullCandidate(
  raw: JsonObject,
  discoveredAt: number,
  bound = false,
): GithubPullCandidate {
  if (raw.state !== 'open' && raw.state !== 'closed') throw new GithubFault('invalid-response')
  return {
    number: requiredNumber(raw.number),
    state: raw.state,
    updatedAt: requiredTime(raw.updated_at),
    discoveredAt,
    ...(raw.closed_at != null ? { closedAt: requiredTime(raw.closed_at) } : {}),
    ...(bound ? { bound: true } : {}),
  }
}

export function githubPullObservation(
  raw: JsonObject,
  repo: GithubRepository,
  number: number,
  expectedId?: string,
): GithubPullObservation {
  const catalog = githubPullCandidate(raw, 0)
  const head = githubObject(raw.head)
  if (
    githubId(githubObject(githubObject(raw.base).repo).id) !== repo.repoId ||
    catalog.number !== number ||
    (expectedId && githubId(raw.id) !== expectedId) ||
    !validGithubSha(head.sha) ||
    !catalog.state ||
    catalog.updatedAt === undefined
  ) {
    throw new GithubFault('invalid-response')
  }
  const headRepoId = githubId(githubObject(head.repo).id)
  return {
    number,
    headSha: head.sha,
    state: catalog.state,
    updatedAt: catalog.updatedAt,
    ...(headRepoId ? { headRepoId } : {}),
    ...(catalog.closedAt !== undefined ? { closedAt: catalog.closedAt } : {}),
    ...(raw.merged_at != null ? { mergedAt: requiredTime(raw.merged_at) } : {}),
  }
}

export function githubPullTerminal(
  raw: JsonObject,
  pull: GithubPullObservation,
  repo: GithubRepository,
): GithubPollEvent | undefined {
  const occurredAt = pull.mergedAt ?? (pull.state === 'closed' ? pull.closedAt : undefined)
  if (occurredAt === undefined) return
  const id = requiredId(raw.id)
  const target = eventTarget(repo, pull.number, 'pull', id)
  // 合并与平台同时派生的关闭共用一次终态；只有 Pulls 返回的 merged_by 可证明合并者。
  return makeEvent(
    pull.mergedAt === undefined ? 'closed' : 'merged',
    `pull-terminal/${id}/${occurredAt}`,
    occurredAt,
    githubActor(raw.merged_by) ?? null,
    target,
    target.subject.url,
  )
}

export function githubRunEvent(
  repo: GithubRepository,
  key: GithubRunKey,
  snapshot: GithubRunSnapshot,
): GithubPollEvent {
  const { status, conclusion } = snapshot
  const { runId, attempt, headSha, workflowId, pullNumber } = key
  const target = {
    ...eventTarget(repo, pullNumber, 'pull', runId),
    run: { runId, attempt, headSha, workflowId, status, conclusion },
  }
  return makeEvent(
    'ci',
    `run/${key.runId}/${key.attempt}/${status}${conclusion ? `/${conclusion}` : ''}`,
    snapshot.occurredAt,
    null,
    target,
    snapshot.permalink,
  )
}
