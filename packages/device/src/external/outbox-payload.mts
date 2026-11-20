import { join } from 'node:path'
import type { ExternalIssueId, ExternalRepo } from '../../../protocol/src/external-sources.mjs'
import { digest, GithubWriteFault, redactGithubSecrets } from './github/write-api.mjs'
import { type GithubFeedbackAction, isGithubFeedbackAction } from './outbox-feedback-intent.mjs'
import { ExternalPrivateFiles } from './secrets-files.mjs'

export type ExternalWriteIntent =
  | { action: 'comment'; body: string }
  | { action: 'draft_pr'; title: string; body: string; base: string; head: string; headSha: string }
  | { action: 'status'; state: 'pending' | 'success' | 'error'; headSha: string }
export type ExternalWriteAuthorization = { botUserId: string; credentialRef: string }
export type ExternalFeedbackPayload = GithubFeedbackAction & ExternalWriteAuthorization
export type ExternalWritePayload =
  | (ExternalWriteIntent & ExternalWriteAuthorization)
  | ExternalFeedbackPayload

export function isGithubFeedbackPayload(
  payload: ExternalWritePayload,
): payload is ExternalFeedbackPayload {
  return isGithubFeedbackAction(payload.action)
}

export function feedbackBody(value: string): string {
  return text(value, 8192)
}

export function validGithubBranch(branch: unknown): branch is string {
  return (
    typeof branch === 'string' &&
    branch.length <= 240 &&
    /^[a-z\d_][a-z\d._/-]*$/i.test(branch) &&
    !branch.includes('..') &&
    branch
      .split('/')
      .every(
        (segment) =>
          /^[a-z\d_][a-z\d._-]*$/i.test(segment) &&
          !segment.endsWith('.') &&
          !segment.endsWith('.lock'),
      )
  )
}

// 工作线自行推送。设备只接收指定前缀且由此 X-n 计算出的 head，用工作标识允许同一 X-n 多个草稿。
export function externalDraftHead(
  repo: ExternalRepo,
  managerId: string,
  issueId: ExternalIssueId,
  workId: string,
): string {
  if (
    !validGithubBranch(repo.headNamespace.replace(/\/$/, '')) ||
    !/^[a-z\d][a-z\d_-]{0,40}$/i.test(workId) ||
    !/^X-[1-9]\d*$/.test(issueId)
  )
    throw new GithubWriteFault('external_draft_head_invalid')
  return `${headPrefix(repo, managerId, issueId)}${workId}`
}

function headPrefix(repo: ExternalRepo, managerId: string, issueId: ExternalIssueId): string {
  return `${repo.headNamespace.replace(/\/$/, '')}/${issueId.toLowerCase()}-${digest(managerId).slice(0, 12)}-`
}

export function validateDraftLocation(
  repo: ExternalRepo,
  managerId: string,
  issueId: ExternalIssueId,
  head: string,
  base: string,
): void {
  const prefix = headPrefix(repo, managerId, issueId)
  if (
    !validGithubBranch(head) ||
    !validGithubBranch(base) ||
    !repo.allowedBase.includes(base) ||
    !head.startsWith(prefix) ||
    head === base ||
    !/^[a-z\d][a-z\d_-]{0,40}$/i.test(head.slice(prefix.length))
  )
    throw new GithubWriteFault('external_draft_branch_not_allowed')
}

const tokenPattern = /(?:github_pat_|gh[pousr]_)[a-z\d_]{15,}/i
function text(value: unknown, maxBytes: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > maxBytes ||
    tokenPattern.test(value) ||
    value.includes('<!-- litch-operation:') ||
    value.includes('<!-- litch-ack:') ||
    value.includes('\0') ||
    redactGithubSecrets(value) !== value
  )
    throw new GithubWriteFault('external_write_text_invalid')
  return value
}
export const validSha = (sha: unknown): sha is string =>
  typeof sha === 'string' && /^[a-f\d]{40}$/.test(sha) && !/^0+$/.test(sha)

export function normalizedIntent(intent: ExternalWriteIntent): ExternalWriteIntent {
  switch (intent.action) {
    case 'comment':
      return { action: 'comment', body: text(intent.body, 32 * 1024) }
    case 'draft_pr':
      if (
        !validSha(intent.headSha) ||
        !validGithubBranch(intent.head) ||
        !validGithubBranch(intent.base)
      )
        throw new GithubWriteFault('external_draft_branch_invalid')
      return {
        action: 'draft_pr',
        title: text(intent.title, 256),
        body: text(intent.body, 32 * 1024, true),
        head: intent.head,
        base: intent.base,
        headSha: intent.headSha,
      }
    case 'status':
      if (!validSha(intent.headSha) || !['pending', 'success', 'error'].includes(intent.state))
        throw new GithubWriteFault('external_progress_invalid')
      return { action: 'status', headSha: intent.headSha, state: intent.state }
    default:
      throw new GithubWriteFault('external_write_action_not_allowed')
  }
}

export class ExternalWritePayloads {
  private readonly files: ExternalPrivateFiles
  constructor(stateDirectory: string) {
    this.files = new ExternalPrivateFiles(join(stateDirectory, 'external-outbox'))
  }
  save(
    operationId: string,
    payload: ExternalWritePayload,
  ): { payloadRef: string; payloadHash: string } {
    const raw = JSON.stringify(payload)
    const payloadHash = digest(raw)
    const payloadRef = `${operationId}-${payloadHash}`
    this.files.write(payloadRef, raw)
    return { payloadRef, payloadHash }
  }
  get(payloadRef: string, payloadHash: string): ExternalWritePayload {
    const raw = this.files.read(payloadRef)
    if (!raw || digest(raw) !== payloadHash)
      throw new GithubWriteFault('external_payload_unavailable')
    return JSON.parse(raw) as ExternalWritePayload
  }
  notePlatformId(operationId: string, id: string): void {
    this.files.write(`lookup-${operationId}`, id)
  }
  platformId(operationId: string): string | null {
    return this.files.read(`lookup-${operationId}`)
  }
  purge(payloadRef: string, operationId: string): void {
    this.files.remove(payloadRef)
    this.files.remove(`lookup-${operationId}`)
  }

  sweep(before: number, needsFile: (operationId: string, key: string) => boolean): void {
    for (const key of this.files.keys()) {
      const match = /^(?:lookup-)?(ghw-[a-f\d]{48})(?:-[a-f\d]{64})?$/.exec(key)
      const operationId = match?.[1]
      if (!operationId && !key.startsWith('temporary-')) continue
      const changed = this.files.modifiedAt(key)
      if (changed === null || changed > before || (operationId && needsFile(operationId, key)))
        continue
      this.files.remove(key)
    }
  }
}
