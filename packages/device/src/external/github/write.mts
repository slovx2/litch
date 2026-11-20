import type {
  ExternalRef,
  ExternalRepo,
  ExternalWriteReceipt,
} from '../../../../protocol/src/external-sources.mjs'
import type { ExternalOutboxRecord } from '../../external-store.mjs'
import type { ExternalWritePayload } from '../outbox-payload.mjs'
import { isGithubFeedbackPayload, validateDraftLocation } from '../outbox-payload.mjs'
import { matchesGithubThread } from '../outbox-read.mjs'
import type { GithubCredentialSnapshot } from '../secrets.mjs'
import {
  digest,
  type GithubSender,
  GithubWriteFault,
  githubPages,
  githubRepoPath,
  type JsonObject,
  numericId,
  object,
} from './write-api.mjs'
import {
  type GithubPreparedWrite,
  githubFeedbackProof,
  lookupGithubFeedback,
  prepareGithubFeedback,
} from './write-feedback.mjs'
import { githubStatusReceipt, matchesGithubStatus, prepareGithubStatus } from './write-status.mjs'

export interface GithubWritten {
  receipt: ExternalWriteReceipt
  prRef?: ExternalRef
}
export interface GithubWriteContext {
  entry: ExternalOutboxRecord
  repo: ExternalRepo
  credential: GithubCredentialSnapshot
  payload: ExternalWritePayload
  send: GithubSender
  now: () => number
  beforeDispatch: () => void
  rememberPlatformId: (id: string) => void
  ackCommentId?: string
}
export const externalWriteMarker = (operationId: string) =>
  `<!-- litch-operation:${operationId} -->`

function taggedBody(context: GithubWriteContext): string {
  return `${'body' in context.payload ? context.payload.body : ''}\n\n${externalWriteMarker(context.entry.operationId)}`
}

function statusTarget(entry: ExternalOutboxRecord) {
  return {
    number: entry.targetRef.number,
    repoId: entry.targetRef.repoId,
    operationId: entry.operationId,
  }
}

function api(context: GithubWriteContext) {
  const { repo, credential, send, beforeDispatch } = context
  const path = githubRepoPath(repo)
  return {
    path,
    get: (endpoint: string) => send(credential.token, endpoint, { beforeDispatch }),
    post: (endpoint: string, post: object, method?: 'PATCH') =>
      send(credential.token, endpoint, { post, beforeDispatch, ...(method ? { method } : {}) }),
    web: `https://github.com/${repo.owner}/${repo.name}`,
  }
}

async function verifyRepository(
  context: GithubWriteContext,
  gh: ReturnType<typeof api>,
): Promise<JsonObject> {
  const metadata = object((await gh.get(gh.path)).body)
  if (
    numericId(metadata.id) !== context.repo.repoId ||
    numericId(object(metadata.owner).id) !== context.credential.metadata.resourceOwnerId ||
    typeof metadata.full_name !== 'string' ||
    metadata.full_name.toLowerCase() !== `${context.repo.owner}/${context.repo.name}`.toLowerCase()
  )
    throw new GithubWriteFault('github_repository_unverified')
  return metadata
}

export async function prepareGithubWrite(
  context: GithubWriteContext,
): Promise<GithubPreparedWrite> {
  const gh = api(context)
  const metadata = await verifyRepository(context, gh)
  const { entry, payload } = context
  if (isGithubFeedbackPayload(payload)) return prepareGithubFeedback(context, gh, payload)
  if (payload.action === 'status') {
    if (!entry.issueId || entry.targetRef.kind !== 'pull_request')
      throw new GithubWriteFault('external_progress_pr_head_unverified')
    return prepareGithubStatus(gh, statusTarget(entry), payload)
  }
  if (payload.action === 'comment') {
    const path = `${gh.path}/issues/${entry.targetRef.number}`
    const issue = object((await gh.get(path)).body)
    if (
      numericId(issue.number) !== entry.targetRef.number ||
      Boolean(issue.pull_request) !== (entry.targetRef.kind === 'pull_request')
    )
      throw new GithubWriteFault('github_thread_unverified')
    return { endpoint: `${path}/comments`, body: { body: taggedBody(context) } }
  }
  if (!entry.issueId) throw new GithubWriteFault('external_draft_requires_issue')
  validateDraftLocation(context.repo, entry.managerId, entry.issueId, payload.head, payload.base)
  if (
    typeof metadata.default_branch !== 'string' ||
    metadata.default_branch === payload.head ||
    context.repo.allowedBase.includes(payload.head)
  )
    throw new GithubWriteFault('external_draft_branch_not_allowed')
  const ref = object((await gh.get(`${gh.path}/git/ref/heads/${payload.head}`)).body)
  if (
    ref.ref !== `refs/heads/${payload.head}` ||
    object(ref.object).type !== 'commit' ||
    object(ref.object).sha !== payload.headSha
  )
    throw new GithubWriteFault('external_draft_head_does_not_match')
  return {
    endpoint: `${gh.path}/pulls`,
    body: {
      title: payload.title,
      body: taggedBody(context),
      head: payload.head,
      base: payload.base,
      draft: true,
    },
  }
}

function proof(
  context: GithubWriteContext,
  value: JsonObject,
  via: GithubWritten['receipt']['verifiedBy'],
  requestId?: string,
): GithubWritten | null {
  const { entry, payload, repo, now } = context
  const gh = api(context)
  if (isGithubFeedbackPayload(payload))
    return githubFeedbackProof(context, gh, payload, value, via, requestId)
  const id = numericId(value.id)
  if (!id) return null
  const at =
    typeof value.created_at === 'string' ? Math.floor(Date.parse(value.created_at) / 1000) : now()
  if (!Number.isFinite(at)) return null
  const receipt = (url: string): ExternalWriteReceipt => ({
    objectId: id,
    url,
    at,
    botUserId: payload.botUserId,
    verifiedBy: via,
    ...(requestId ? { requestId } : {}),
  })
  if (payload.action === 'status') {
    const target = statusTarget(entry)
    return matchesGithubStatus(gh, target, payload, value)
      ? githubStatusReceipt(gh, target, receipt)
      : null
  }
  if (
    numericId(object(value.user).id) !== payload.botUserId ||
    typeof value.body !== 'string' ||
    digest(value.body) !== digest(taggedBody(context))
  )
    return null
  if (payload.action === 'comment') {
    if (
      !matchesGithubThread(value.issue_url, gh.path, repo.repoId, 'issues', entry.targetRef.number)
    )
      return null
    const family = entry.targetRef.kind === 'pull_request' ? 'pull' : 'issues'
    return { receipt: receipt(`${gh.web}/${family}/${entry.targetRef.number}#issuecomment-${id}`) }
  }
  const head = object(value.head)
  const base = object(value.base)
  const number = numericId(value.number)
  if (
    !entry.issueId ||
    !number ||
    numericId(object(head.repo).id) !== repo.repoId ||
    numericId(object(base.repo).id) !== repo.repoId ||
    head.ref !== payload.head ||
    head.sha !== payload.headSha ||
    base.ref !== payload.base ||
    (via === 'response' && (value.draft !== true || value.title !== payload.title))
  )
    return null
  const url = `${gh.web}/pull/${number}`
  return {
    receipt: receipt(url),
    prRef: {
      provider: 'github',
      repoId: repo.repoId,
      number,
      kind: 'pull_request',
      url,
      managerId: entry.managerId,
      issueId: entry.issueId,
      origin: 'write_receipt',
      createdAt: at,
    },
  }
}

export async function sendPreparedGithubWrite(
  context: GithubWriteContext,
  prepared: Awaited<ReturnType<typeof prepareGithubWrite>>,
): Promise<GithubWritten> {
  const response = await api(context).post(prepared.endpoint, prepared.body, prepared.method)
  const value = object(response.body)
  const id = numericId(context.payload.action === 'draft_pr' ? value.number : value.id)
  if (id) context.rememberPlatformId(id)
  const written = proof(context, value, 'response', response.requestId)
  const acceptedResult =
    context.payload.action === 'reaction_add'
      ? [200, 201]
      : prepared.method === 'PATCH'
        ? [200]
        : [201]
  if (!acceptedResult.includes(response.status) || !written)
    throw new GithubWriteFault('github_write_receipt_unverified')
  return written
}

export async function lookupGithubWrite(
  context: GithubWriteContext,
  knownId?: string,
): Promise<GithubWritten | null> {
  const gh = api(context)
  await verifyRepository(context, gh)
  if (isGithubFeedbackPayload(context.payload))
    return lookupGithubFeedback(context, gh, context.payload, knownId)
  const known = numericId(knownId)
  if (known && context.payload.action !== 'status') {
    const path =
      context.payload.action === 'comment'
        ? `${gh.path}/issues/comments/${known}`
        : `${gh.path}/pulls/${known}`
    try {
      const value = object((await gh.get(path)).body)
      const actualId = numericId(context.payload.action === 'comment' ? value.id : value.number)
      const verified = actualId === known ? proof(context, value, 'lookup') : null
      if (verified) return verified
    } catch (error) {
      if (!(error instanceof GithubWriteFault) || error.status !== 404) throw error
    }
  }
  const { payload, repo, entry } = context
  const target =
    payload.action === 'status'
      ? `${gh.path}/commits/${payload.headSha}/statuses`
      : payload.action === 'comment'
        ? `${gh.path}/issues/${entry.targetRef.number}/comments`
        : `${gh.path}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${payload.head}`)}&base=${encodeURIComponent(payload.base)}`
  const candidates = await githubPages(gh.get, target)
  const matches: GithubWritten[] = []
  for (const candidate of candidates) {
    if (payload.action === 'draft_pr') {
      // 列表只做查找，详情再核对数字仓库、提交和可见状态；ready、closed 和 merged 均可对账。
      const number = numericId(candidate.number)
      if (!number || !proof(context, candidate, 'lookup')) continue
      const verified = proof(
        context,
        object((await gh.get(`${gh.path}/pulls/${number}`)).body),
        'lookup',
      )
      if (verified) matches.push(verified)
    } else {
      const verified = proof(context, candidate, 'lookup')
      if (verified) matches.push(verified)
    }
  }
  if (matches.length > 1) throw new GithubWriteFault('github_reconcile_multiple_matches')
  return matches[0] ?? null
}
