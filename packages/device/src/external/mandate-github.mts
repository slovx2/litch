// GitHub 复核适配层。B 提供固定 API、无损 ID 和内容版本解析，D 提供同源凭据。
import type {
  ExternalEvent,
  ExternalRepo,
  ExternalSource,
  ExternalSubject,
} from '../../../protocol/src/external-sources.mjs'
import {
  githubActor,
  lookupGithubRole as githubRole,
  mentionsGithubLogin,
  verifyGithubBot,
} from './github/identity.mjs'
import { githubActionStub, githubActionType } from './github/poll-events.mjs'
import { githubNextPage } from './github/poll-pages.mjs'
import {
  type GithubApi,
  githubRepoPath,
  githubSubjectNumber,
  verifyGithubRepository,
} from './github/read-api.mjs'
import {
  type GithubContentKind,
  githubBody,
  githubContentHash,
  githubContentTimes,
  githubContentVersion,
} from './github/read-content.mjs'
import type { RecheckExternalEvent } from './mandate.mjs'
import type { InspectedExternalSubject } from './mandate-link.mjs'
import type { ExternalRouteIdentity, RoleLookup } from './routing.mjs'

type ObjectRow = Record<string, unknown>

/** 与 D 的 externalWriteMarker 格式一致；标记本身只用于否决 owner 来源。 */
export function githubAgentMarkerIds(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/<!-- litch-operation:([A-Za-z0-9_-]{1,128}) -->/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    ),
  ]
}

const object = (input: unknown): ObjectRow =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as ObjectRow) : {}
const id = (value: unknown) =>
  typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : undefined

/** H 只负责注入 D 按来源分发的凭据/API，不重新实现复核规则。 */
export function createGithubExternalVerification(
  apiFor: (source: ExternalSource) => Promise<GithubApi>,
  sourceById: (sourceId: string) => ExternalSource | null,
) {
  const lookupGithubRole: RoleLookup = async (sourceId, repo, actor) => {
    try {
      const source = sourceById(sourceId)
      if (!source?.enabled) return { state: 'unavailable', reason: 'source_paused' }
      const result = await githubRole(await apiFor(source), repo, actor)
      return result.state === 'unavailable' && result.retryAt !== undefined
        ? { ...result, retryAt: Math.ceil(result.retryAt / 1000) }
        : result
    } catch {
      return { state: 'unavailable', reason: 'role_lookup_failed' }
    }
  }

  async function subjectInRepo(
    api: GithubApi,
    repo: ExternalRepo,
    number: string,
    kind: ExternalSubject['kind'],
  ) {
    if (!id(number)) return null
    const base = githubRepoPath(repo)
    const raw = object(
      (await api.get(`${base}/${kind === 'issue' ? 'issues' : 'pulls'}/${number}`)).body,
    )
    const url = `https://github.com/${repo.owner}/${repo.name}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`
    if (
      (id(raw.number) ?? (Number.isSafeInteger(raw.number) ? String(raw.number) : undefined)) !==
        number ||
      typeof raw.html_url !== 'string' ||
      raw.html_url.toLowerCase() !== url.toLowerCase() ||
      (kind === 'issue' && raw.pull_request) ||
      (kind === 'pull_request' && id(object(object(raw.base).repo).id) !== repo.repoId)
    )
      return null
    const labels = Array.isArray(raw.labels)
      ? raw.labels.flatMap((label) => {
          const value = id(object(label).id)
          return value ? [value] : []
        })
      : null
    if (!labels || labels.length !== (raw.labels as unknown[]).length) return null
    return {
      base,
      raw,
      labels,
      subject: { provider: 'github', repoId: repo.repoId, number, kind, url } as const,
    }
  }

  const inspectSubject = async ({
    source,
    repo,
    number,
    kind,
  }: {
    source: ExternalSource
    repo: ExternalRepo
    number: string
    kind: ExternalSubject['kind']
  }): Promise<InspectedExternalSubject | null> => {
    try {
      const api = await apiFor(source)
      await verifyGithubRepository(api, repo)
      const current = await subjectInRepo(api, repo, number, kind)
      if (!current) return null
      const { raw, subject } = current
      const actor = githubActor(raw.user)
      const head = object(raw.head)
      const base = object(raw.base).ref
      const headRepo = id(object(head.repo).id)
      const agentOperationIds = githubAgentMarkerIds(githubBody(raw))
      return {
        subject,
        ...(actor ? { actorUserId: actor.userId } : {}),
        ...(headRepo && typeof head.ref === 'string'
          ? { head: { repoId: headRepo, ref: head.ref } }
          : {}),
        ...(typeof base === 'string' ? { base } : {}),
        agentMarked: agentOperationIds.length > 0,
        agentOperationIds,
      }
    } catch {
      return null
    }
  }

  async function contentProof(
    api: GithubApi,
    source: ExternalSource,
    repo: ExternalRepo,
    event: ExternalEvent,
    current: NonNullable<Awaited<ReturnType<typeof subjectInRepo>>>,
    kind: GithubContentKind,
    addresses: readonly ExternalRouteIdentity[],
  ) {
    const { base, raw: parent, subject, labels } = current
    const objectId = id(event.targetEvidence.sourceEventId)
    if (!objectId) return null
    let raw = parent
    if (kind === 'issue-comment') {
      raw = object((await api.get(`${base}/issues/comments/${objectId}`)).body)
      if (String(githubSubjectNumber(raw.issue_url, repo, 'issues')) !== subject.number) return null
    } else if (kind === 'review-comment' || kind === 'review') {
      const endpoint =
        kind === 'review'
          ? `pulls/${subject.number}/reviews/${objectId}`
          : `pulls/comments/${objectId}`
      raw = object((await api.get(`${base}/${endpoint}`)).body)
      if (
        subject.kind !== 'pull_request' ||
        String(githubSubjectNumber(raw.pull_request_url, repo, 'pulls')) !== subject.number ||
        (kind === 'review' && raw.state === 'PENDING')
      )
        return null
    }
    const author = githubActor(raw.user)
    if (
      id(raw.id) !== objectId ||
      author?.userId !== event.actorEvidence?.userId ||
      !author ||
      (kind !== 'review' &&
        (typeof raw.html_url !== 'string' ||
          raw.html_url.toLowerCase() !== event.permalink.toLowerCase()))
    )
      return null
    const body = githubBody(raw)
    const { updated, created } = githubContentTimes(raw, kind)
    const version = githubContentVersion(updated, githubContentHash(body))
    if (
      version !== event.contentVersion ||
      (event.targetEvidence.publication === 'published' && created !== updated)
    )
      return null
    await verifyGithubBot(api, source.botUserId)
    return {
      event: {
        ...event,
        actorEvidence: author,
        targetEvidence: {
          ...event.targetEvidence,
          subject,
          labelIds: labels,
        },
      },
      agentMarked: githubAgentMarkerIds(body).length > 0,
      addressedBotIds: addresses
        .filter(({ login }) => mentionsGithubLogin(body, login))
        .map(({ botUserId }) => botUserId),
    }
  }

  async function actionProof(
    api: GithubApi,
    repo: ExternalRepo,
    event: ExternalEvent,
    current: NonNullable<Awaited<ReturnType<typeof subjectInRepo>>>,
  ) {
    const { base, raw, subject, labels } = current
    const target = event.targetEvidence
    const currentLabel =
      event.kind === 'labeled' && Array.isArray(raw.labels)
        ? raw.labels
            .map(object)
            .find((label) =>
              target.labelId
                ? id(label.id) === target.labelId
                : !!target.labelName &&
                  typeof label.name === 'string' &&
                  label.name.toLowerCase() === target.labelName.toLowerCase(),
            )
        : undefined
    const currentLabelName = typeof currentLabel?.name === 'string' ? currentLabel.name : undefined
    const actions = {
      assigned: {
        withdrawn: 'unassigned',
        field: 'assigneeId',
        id: target.assigneeUserId,
        entries: raw.assignees,
      },
      review_requested: {
        withdrawn: 'review_request_removed',
        field: 'reviewerId',
        id: target.reviewerUserId,
        entries: raw.requested_reviewers,
      },
      labeled: {
        withdrawn: 'unlabeled',
        field: 'labelId',
        id: id(currentLabel?.id),
        entries: raw.labels,
      },
    } as const
    if (event.kind !== 'assigned' && event.kind !== 'review_requested' && event.kind !== 'labeled')
      return null
    const action = actions[event.kind]
    if (
      !action.id ||
      !Array.isArray(action.entries) ||
      !action.entries.some((one) => id(object(one).id) === action.id)
    )
      return null
    let path: string | undefined = `${base}/issues/${subject.number}/timeline?per_page=100&page=1`
    let matched: ReturnType<typeof githubActionStub> | undefined
    // 达到边界仍有下一页时，不从不完整的历史推断原触发仍然有效。
    for (let page = 0; path && page < 8; page++) {
      const response = await api.get(path)
      if (!Array.isArray(response.body) || response.body.length > 100) return null
      for (const value of response.body) {
        const row = object(value)
        const kind = githubActionType(row)
        if (!kind || (kind !== event.kind && kind !== action.withdrawn)) continue
        const stub = githubActionStub(row, kind)
        const namedLabel =
          action.field === 'labelId' &&
          !stub.labelId &&
          !!stub.labelName &&
          [target.labelName, currentLabelName].some(
            (name) => name?.toLowerCase() === stub.labelName?.toLowerCase(),
          )
        if (stub[action.field] !== action.id && !namedLabel) continue
        const occurredAt = Math.floor(stub.at / 1000)
        if (kind === action.withdrawn && occurredAt >= event.occurredAt) return null
        if (
          kind === event.kind &&
          occurredAt === event.occurredAt &&
          stub.id === target.sourceEventId &&
          stub.actor?.userId === event.actorEvidence?.userId
        )
          matched = stub
      }
      path = githubNextPage(response.headers, path, repo) ?? undefined
    }
    if (path || !matched?.actor) return null
    const label =
      event.kind === 'labeled' && currentLabelName
        ? { labelName: currentLabelName, labelId: action.id }
        : {}
    if (event.kind === 'labeled' && !currentLabelName) return null
    return {
      agentMarked: false,
      addressedBotIds: [],
      event: {
        ...event,
        actorEvidence: matched.actor,
        targetEvidence: { ...target, subject, labelIds: labels, ...label },
      },
    }
  }

  const recheckEvent: RecheckExternalEvent = async ({ source, repo, event, addresses }) => {
    try {
      const api = await apiFor(source)
      await verifyGithubRepository(api, repo)
      const { number, kind } = event.targetEvidence.subject
      const current = await subjectInRepo(api, repo, number, kind)
      if (!current) return null
      const contentKinds: Partial<Record<ExternalEvent['kind'], GithubContentKind>> = {
        issue: 'issue',
        pull_request: 'pull',
        comment: 'issue-comment',
        review: 'review',
        review_comment: 'review-comment',
      }
      const contentKind = contentKinds[event.kind]
      return contentKind
        ? await contentProof(api, source, repo, event, current, contentKind, addresses)
        : await actionProof(api, repo, event, current)
    } catch {
      return null
    }
  }

  // GitHub 时间线标签事件可只有名字；以仓库当前标签集合核对数字 ID。
  async function snapshotLabels(
    source: ExternalSource,
    repo: ExternalRepo,
    event: ExternalEvent,
  ): Promise<ExternalEvent> {
    try {
      const api = await apiFor(source)
      await verifyGithubRepository(api, repo)
      const { number, kind } = event.targetEvidence.subject
      const current = await subjectInRepo(api, repo, number, kind)
      const labelId =
        event.kind === 'labeled' &&
        !event.targetEvidence.labelId &&
        event.targetEvidence.labelName &&
        Array.isArray(current?.raw.labels)
          ? id(
              current.raw.labels
                .map(object)
                .find(
                  (label) =>
                    typeof label.name === 'string' &&
                    label.name.toLowerCase() === event.targetEvidence.labelName?.toLowerCase(),
                )?.id,
            )
          : undefined
      return current
        ? {
            ...event,
            targetEvidence: {
              ...event.targetEvidence,
              labelIds: current.labels,
              ...(labelId ? { labelId } : {}),
            },
          }
        : event
    } catch {
      return event
    }
  }
  return { lookupGithubRole, inspectSubject, recheckEvent, snapshotLabels }
}
