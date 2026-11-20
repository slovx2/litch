import { createHash } from 'node:crypto'
import { GithubFault, githubTime, type JsonObject } from './read-api.mjs'

export function githubContentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function githubContentVersion(time: number, hash: string): string {
  return `${new Date(time).toISOString()}/${hash}`
}

export function githubBody(raw: JsonObject): string {
  if (typeof raw.body === 'string') return raw.body
  if (raw.body === null) return ''
  throw new GithubFault('invalid-response')
}

export type GithubContentKind = 'issue' | 'pull' | 'issue-comment' | 'review-comment' | 'review'

export function githubContentTimes(
  raw: JsonObject,
  kind: GithubContentKind,
): { created: number; updated: number } {
  const created = githubTime(kind === 'review' ? raw.submitted_at : raw.created_at)
  const updated = raw.updated_at == null && kind === 'review' ? created : githubTime(raw.updated_at)
  if (created === undefined || updated === undefined || updated < created)
    throw new GithubFault('invalid-response')
  return { created, updated }
}

export function githubContentAnchor(kind: GithubContentKind, id: string): string {
  if (kind === 'issue-comment') return `#issuecomment-${id}`
  if (kind === 'review-comment') return `#discussion_r${id}`
  if (kind === 'review') return `#pullrequestreview-${id}`
  return ''
}
