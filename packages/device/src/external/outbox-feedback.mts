import {
  type ExternalRepo,
  type ExternalSource,
  type ExternalSubject,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import type {
  ExternalOutboxRecord,
  ExternalStore,
  NewExternalOutboxRecord,
} from '../external-store.mjs'
import { digest, GithubWriteFault, numericId } from './github/write-api.mjs'
import { feedbackOperationId } from './github/write-feedback.mjs'
import { sourceAndRepo } from './outbox-authority.mjs'
import {
  type GithubFeedbackAction,
  type GithubFeedbackIntent,
  isGithubFeedbackAction,
} from './outbox-feedback-intent.mjs'
import { type ExternalWritePayloads, feedbackBody } from './outbox-payload.mjs'
import type { ExternalGithubSecrets, GithubCredentialSnapshot } from './secrets.mjs'
import type { GithubManagerAssignment } from './secrets-agent-login.mjs'

type Assigned = (managerId: string) => GithubManagerAssignment | null
type FeedbackFlag = (repo: ExternalRepo, source: ExternalSource) => boolean
export type FeedbackEnqueueResult = 'queued' | 'skipped' | 'retry'

export class GithubFeedbackOutbox {
  private readonly options: {
    store: ExternalStore
    secrets: ExternalGithubSecrets
    payloads: ExternalWritePayloads
    assign: Assigned
    enabled?: FeedbackFlag
    now: () => number
  }
  constructor(options: GithubFeedbackOutbox['options']) {
    this.options = options
  }

  enqueue(input: GithubFeedbackIntent): FeedbackEnqueueResult {
    const { store, secrets, payloads } = this.options
    try {
      const { sourceId, managerId, identityId, botUserId, subject, idempotencyKey } = input
      const action = this.action(input)
      if (
        /^[-a-z\d_:]{1,250}$/i.test(idempotencyKey) === false ||
        subject.provider !== 'github' ||
        !numericId(subject.repoId) ||
        !numericId(subject.number) ||
        identityId !== botUserId
      )
        return 'skipped'
      const operationId = feedbackOperationId(sourceId, subject.repoId, idempotencyKey)
      const intentHash = digest(JSON.stringify(action))
      const previous = store.queue.outboxRecord(operationId)
      if (previous)
        return previous.managerId === managerId &&
          previous.sourceId === sourceId &&
          externalSubjectKey(previous.targetRef) === externalSubjectKey(subject) &&
          previous.targetRef.kind === subject.kind &&
          'intentHash' in previous &&
          previous.intentHash === intentHash &&
          'feedbackBotId' in previous &&
          previous.feedbackBotId === botUserId
          ? 'queued'
          : 'skipped'

      const source = store.config.source(sourceId)
      if (source && !source.enabled) return 'retry'
      const checked = this.check(sourceId, managerId, subject)
      if (checked.assignment.identityId !== identityId) return 'skipped'
      const credential = secrets.activeForRepository(subject.repoId, identityId)
      if (
        credential.metadata.botUserId !== botUserId ||
        secrets.feedbackWriteMissing(credential, subject.repoId, subject.kind)
      )
        return 'skipped'
      if (action.action === 'ack_comment_update') {
        const parent = this.original({ sourceId, managerId, targetRef: subject }, action.createKey)
        if (!parent) return 'skipped'
        if (['blocked', 'failed', 'canceled'].includes(parent.state)) return 'skipped'
      }
      const ref = store.ref(subject)
      const record: NewExternalOutboxRecord & { intentHash: string; feedbackBotId: string } = {
        operationId,
        idempotencyKey: `github-feedback:${operationId}`,
        sourceId,
        managerId,
        actorThreadId: checked.manager.threadId,
        action: action.action,
        intentHash,
        feedbackBotId: botUserId,
        targetRef: subject,
        policyRevision: checked.source.revision,
        ...(ref?.managerId === managerId ? { issueId: ref.issueId } : {}),
        ...payloads.save(operationId, {
          ...action,
          botUserId,
          credentialRef: credential.metadata.credentialRef,
        }),
      }
      store.queue.enqueueOutbox(record)
      return 'queued'
    } catch (error) {
      if (error instanceof GithubWriteFault) return 'skipped'
      throw error
    }
  }

  check(sourceId: string, managerId: string, subject: ExternalSubject, revision?: number) {
    const { store } = this.options
    const manager = store.manager.manager(managerId)
    const assignment = this.options.assign(managerId)
    if (
      manager?.status !== 'active' ||
      !assignment?.identityId ||
      !assignment.repoIds.includes(subject.repoId)
    )
      throw new GithubWriteFault('github_feedback_identity_not_assigned')
    const { source, repo } = sourceAndRepo(store, sourceId, subject, revision)
    const enabled =
      (!('immediateFeedback' in repo) || repo.immediateFeedback !== false) &&
      this.options.enabled?.(repo, source) !== false
    if (!enabled) throw new GithubWriteFault('github_feedback_disabled')
    return { assignment, manager, source, repo }
  }

  recheck(entry: ExternalOutboxRecord, credential: GithubCredentialSnapshot): void {
    const { assignment } = this.check(
      entry.sourceId,
      entry.managerId,
      entry.targetRef,
      entry.policyRevision,
    )
    if (assignment.identityId !== credential.metadata.botUserId)
      throw new GithubWriteFault('external_write_identity_changed')
    if (
      this.options.secrets.feedbackWriteMissing(
        credential,
        entry.targetRef.repoId,
        entry.targetRef.kind,
      )
    )
      throw new GithubWriteFault('github_feedback_write_permission_required')
  }

  /** 等原评论对账成功后才能编辑，不发送另一条替代评论。 */
  waitForOriginal(entry: ExternalOutboxRecord): boolean {
    if (String(entry.action) !== 'ack_comment_update') return false
    try {
      const payload = this.options.payloads.get(entry.payloadRef, entry.payloadHash)
      if (payload.action !== 'ack_comment_update') return false
      const original = this.original(entry, payload.createKey)
      if (
        !original ||
        !['queued', 'sending', 'unknown'].includes(original.state) ||
        original.errorClass === 'external_write_manual_confirmation_required'
      )
        return false
      this.options.store.deferQueuedExternalWrite(
        entry.operationId,
        entry.revision,
        this.options.now() + 15,
      )
      return true
    } catch {
      return false
    }
  }

  originalCommentId(entry: ExternalOutboxRecord, key: string, botUserId: string): string {
    const original = this.original(entry, key)
    const id = numericId(original?.receipt?.objectId)
    if (original?.state !== 'confirmed' || original.receipt?.botUserId !== botUserId || !id)
      throw new GithubWriteFault('github_feedback_original_unavailable')
    return id
  }

  private original(
    entry: Pick<ExternalOutboxRecord, 'sourceId' | 'managerId' | 'targetRef'>,
    key: string,
  ) {
    const original = this.options.store.queue.outboxRecord(
      feedbackOperationId(entry.sourceId, entry.targetRef.repoId, key),
    )
    return original &&
      String(original.action) === 'ack_comment_create' &&
      original.managerId === entry.managerId &&
      externalSubjectKey(original.targetRef) === externalSubjectKey(entry.targetRef) &&
      original.targetRef.kind === entry.targetRef.kind
      ? original
      : null
  }

  private action(input: GithubFeedbackIntent): GithubFeedbackAction {
    if (!isGithubFeedbackAction(input.action))
      throw new GithubWriteFault('github_feedback_action_invalid')
    if (input.action === 'ack_comment_create') {
      if (!/^ack:create:.+$/.test(input.idempotencyKey))
        throw new GithubWriteFault('github_feedback_key_invalid')
      return { action: input.action, text: feedbackBody(input.text) }
    }
    if (input.action === 'ack_comment_update') {
      const id = input.idempotencyKey.slice('ack:update:'.length)
      if (
        !input.idempotencyKey.startsWith('ack:update:') ||
        !id ||
        input.createKey !== `ack:create:${id}`
      )
        throw new GithubWriteFault('github_feedback_key_invalid')
      return { action: input.action, text: feedbackBody(input.text), createKey: input.createKey }
    }
    const { kind, id } = input.comment
    if (
      !numericId(id) ||
      (kind !== 'comment' && kind !== 'review_comment') ||
      (kind === 'review_comment' && input.subject.kind !== 'pull_request') ||
      !['eyes', 'rocket'].includes(input.reaction) ||
      input.idempotencyKey !==
        `reaction:github:${input.subject.repoId}:${kind}:${id}:${input.reaction}`
    )
      throw new GithubWriteFault('github_feedback_reaction_invalid')
    return { action: input.action, comment: { kind, id }, reaction: input.reaction }
  }
}
