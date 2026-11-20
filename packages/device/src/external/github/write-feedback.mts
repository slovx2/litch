import type { ExternalFeedbackPayload } from '../outbox-payload.mjs'
import { matchesGithubThread } from '../outbox-read.mjs'
import type { GithubWriteContext, GithubWritten } from './write.mjs'
import {
  digest,
  GithubWriteFault,
  type GithubWriteResponse,
  githubPages,
  type JsonObject,
  numericId,
  object,
} from './write-api.mjs'

export type GithubPreparedWrite = {
  endpoint: string
  method?: 'PATCH'
  body: Record<string, string | boolean>
}
type Api = { path: string; web: string; get: (endpoint: string) => Promise<GithubWriteResponse> }

export function feedbackOperationId(sourceId: string, repoId: string, key: string): string {
  return `ghw-${digest(JSON.stringify(['github-feedback', sourceId, repoId, key])).slice(0, 48)}`
}
export function githubAckMarker(operationId: string): string {
  return `<!-- litch-ack:${operationId} -->`
}

function ackMarker(
  context: GithubWriteContext,
  payload: Exclude<ExternalFeedbackPayload, { action: 'reaction_add' }>,
) {
  const { sourceId, targetRef, operationId } = context.entry
  const create =
    payload.action === 'ack_comment_update'
      ? feedbackOperationId(sourceId, targetRef.repoId, payload.createKey)
      : operationId
  return githubAckMarker(create)
}

function matchedComment(
  context: GithubWriteContext,
  gh: Api,
  value: JsonObject,
  review: boolean,
): boolean {
  const { number, repoId, kind } = context.entry.targetRef
  return (
    (!review || kind === 'pull_request') &&
    matchesGithubThread(
      review ? value.pull_request_url : value.issue_url,
      gh.path,
      repoId,
      review ? 'pulls' : 'issues',
      number,
    )
  )
}

async function verifyReactionTarget(
  context: GithubWriteContext,
  gh: Api,
  payload: Extract<ExternalFeedbackPayload, { action: 'reaction_add' }>,
): Promise<string> {
  const review = payload.comment.kind === 'review_comment'
  const path = `${gh.path}/${review ? 'pulls' : 'issues'}/comments/${payload.comment.id}`
  const raw = object((await gh.get(path)).body)
  if (numericId(raw.id) !== payload.comment.id || !matchedComment(context, gh, raw, review))
    throw new GithubWriteFault('github_feedback_comment_unverified')
  return `${path}/reactions`
}

export async function prepareGithubFeedback(
  context: GithubWriteContext,
  gh: Api,
  payload: ExternalFeedbackPayload,
): Promise<GithubPreparedWrite> {
  if (payload.action === 'reaction_add')
    return {
      endpoint: await verifyReactionTarget(context, gh, payload),
      body: { content: payload.reaction },
    }
  const body = `${payload.text}\n\n${ackMarker(context, payload)}`
  if (payload.action === 'ack_comment_create') {
    const path = `${gh.path}/issues/${context.entry.targetRef.number}`
    const issue = object((await gh.get(path)).body)
    if (
      numericId(issue.number) !== context.entry.targetRef.number ||
      Boolean(issue.pull_request) !== (context.entry.targetRef.kind === 'pull_request')
    )
      throw new GithubWriteFault('github_thread_unverified')
    return { endpoint: `${path}/comments`, body: { body } }
  }
  const commentId = context.ackCommentId
  if (!numericId(commentId)) throw new GithubWriteFault('github_feedback_original_unavailable')
  const endpoint = `${gh.path}/issues/comments/${commentId}`
  const original = object((await gh.get(endpoint)).body)
  if (
    numericId(original.id) !== commentId ||
    !matchedComment(context, gh, original, false) ||
    numericId(object(original.user).id) !== payload.botUserId ||
    typeof original.body !== 'string' ||
    !original.body.endsWith(`\n\n${ackMarker(context, payload)}`)
  )
    throw new GithubWriteFault('github_feedback_original_unverified')
  return { endpoint, method: 'PATCH', body: { body } }
}

export function githubFeedbackProof(
  context: GithubWriteContext,
  gh: Api,
  payload: ExternalFeedbackPayload,
  value: JsonObject,
  verifiedBy: GithubWritten['receipt']['verifiedBy'],
  requestId?: string,
): GithubWritten | null {
  const id = numericId(value.id)
  if (!id || numericId(object(value.user).id) !== payload.botUserId) return null
  let commentId = id
  let review = false
  if (payload.action === 'reaction_add') {
    if (value.content !== payload.reaction) return null
    commentId = payload.comment.id
    review = payload.comment.kind === 'review_comment'
  } else if (
    !matchedComment(context, gh, value, false) ||
    (payload.action === 'ack_comment_update' && id !== context.ackCommentId) ||
    typeof value.body !== 'string' ||
    digest(value.body) !== digest(`${payload.text}\n\n${ackMarker(context, payload)}`)
  )
    return null
  const stamp = value.updated_at ?? value.created_at
  const at = typeof stamp === 'string' ? Math.floor(Date.parse(stamp) / 1000) : context.now()
  if (!Number.isFinite(at)) return null
  const { number, kind } = context.entry.targetRef
  const url = `${gh.web}/${kind === 'pull_request' ? 'pull' : 'issues'}/${number}${
    review ? `#discussion_r${commentId}` : `#issuecomment-${commentId}`
  }`
  return {
    receipt: {
      objectId: id,
      url,
      at,
      botUserId: payload.botUserId,
      verifiedBy,
      ...(requestId ? { requestId } : {}),
    },
  }
}

export async function lookupGithubFeedback(
  context: GithubWriteContext,
  gh: Api,
  payload: ExternalFeedbackPayload,
  knownId?: string,
): Promise<GithubWritten | null> {
  const verdict = (objectValue: unknown) =>
    githubFeedbackProof(context, gh, payload, object(objectValue), 'lookup')
  if (payload.action === 'ack_comment_update') {
    const id = context.ackCommentId
    if (!id) return null
    return verdict((await gh.get(`${gh.path}/issues/comments/${id}`)).body)
  }
  if (payload.action === 'ack_comment_create' && numericId(knownId)) {
    try {
      const result = verdict((await gh.get(`${gh.path}/issues/comments/${knownId}`)).body)
      if (result?.receipt.objectId === knownId) return result
    } catch (error) {
      if (!(error instanceof GithubWriteFault) || error.status !== 404) throw error
    }
  }
  const path =
    payload.action === 'reaction_add'
      ? `${await verifyReactionTarget(context, gh, payload)}?content=${payload.reaction}`
      : `${gh.path}/issues/${context.entry.targetRef.number}/comments`
  const matched = (await githubPages(gh.get, path)).flatMap((entry) => {
    const found = verdict(entry)
    return found ? [found] : []
  })
  if (matched.length > 1) throw new GithubWriteFault('github_reconcile_multiple_matches')
  return matched[0] ?? null
}
