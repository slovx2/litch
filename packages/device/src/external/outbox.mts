import type {
  ExternalDiagnostic,
  ExternalOutboxSummary,
  ExternalRepo,
  ExternalSource,
  ExternalSubject,
} from '../../../protocol/src/external-sources.mjs'
import {
  type ExternalOutboxRecord,
  type ExternalStore,
  type ExternalWriteCompletion,
  externalOutboxSummary,
  type NewExternalOutboxRecord,
} from '../external-store.mjs'
import { managerNow } from '../manager-store.mjs'
import {
  type GithubWriteContext,
  type GithubWritten,
  lookupGithubWrite,
  prepareGithubWrite,
  sendPreparedGithubWrite,
} from './github/write.mjs'
import { digest, type GithubSender, GithubWriteFault, sendGithub } from './github/write-api.mjs'
import {
  assertAction,
  checkBoundWrite,
  type ExternalManagerActor,
  type ExternalWriteRequest,
  recheckQueuedWrite,
  type StatusGateConfirmed,
  sourceAndRepo,
} from './outbox-authority.mjs'
import { type FeedbackEnqueueResult, GithubFeedbackOutbox } from './outbox-feedback.mjs'
import { type GithubFeedbackIntent, isGithubFeedbackAction } from './outbox-feedback-intent.mjs'
import {
  type ExternalWriteIntent,
  ExternalWritePayloads,
  isGithubFeedbackPayload,
  normalizedIntent,
} from './outbox-payload.mjs'
import { activeManager } from './outbox-read.mjs'
import type { ExternalGithubSecrets, GithubCredentialSnapshot } from './secrets.mjs'
import type { GithubManagerAssignment } from './secrets-agent-login.mjs'
import { privateName } from './secrets-files.mjs'

type TrackedWrite = NewExternalOutboxRecord & { intentHash: string }

const RECONCILE_SECONDS = 600
const LEASE_SECONDS = 120
const MAX_ATTEMPTS = 5
const PAYLOAD_KEEP_SECONDS = 7 * 24 * 60 * 60

export type { ExternalManagerActor, ExternalWriteRequest } from './outbox-authority.mjs'
export { externalDraftHead } from './outbox-payload.mjs'

export class ExternalGithubOutbox {
  private readonly store: ExternalStore
  private readonly secrets: ExternalGithubSecrets
  private readonly payloads: ExternalWritePayloads
  private readonly send: GithubSender
  private readonly now: () => number
  private readonly assignmentForManager: (managerId: string) => GithubManagerAssignment | null
  private readonly statusGateConfirmed: StatusGateConfirmed | undefined
  private readonly feedback: GithubFeedbackOutbox
  private readonly running = new Set<string>()
  private ticking = false
  private nextSweep = 0

  constructor(input: {
    store: ExternalStore
    secrets: ExternalGithubSecrets
    stateDirectory: string
    send?: GithubSender
    now?: () => number
    assignmentForManager: (managerId: string) => GithubManagerAssignment | null
    statusGateConfirmed?: StatusGateConfirmed
    feedbackEnabled?: (repo: ExternalRepo, source: ExternalSource) => boolean
  }) {
    this.store = input.store
    this.secrets = input.secrets
    this.payloads = new ExternalWritePayloads(input.stateDirectory)
    this.send = input.send ?? sendGithub
    this.now = input.now ?? managerNow
    this.statusGateConfirmed = input.statusGateConfirmed
    this.assignmentForManager = input.assignmentForManager
    this.feedback = new GithubFeedbackOutbox({
      store: this.store,
      secrets: this.secrets,
      payloads: this.payloads,
      now: this.now,
      assign: this.assignmentForManager,
      ...(input.feedbackEnabled ? { enabled: input.feedbackEnabled } : {}),
    })
  }

  /** 只消费 C 已随入箱或投递事务持久化的固定动作，不注册成经理工具。 */
  async enqueueFeedback(input: GithubFeedbackIntent): Promise<FeedbackEnqueueResult> {
    return this.feedback.enqueue(input)
  }

  enqueue(actor: ExternalManagerActor, input: ExternalWriteRequest): ExternalOutboxSummary {
    if (actor.kind !== 'manager' || !activeManager(this.store, actor))
      throw new GithubWriteFault('external_write_forbidden')
    const intent = normalizedIntent(input.intent)
    const ids = this.ids(actor, 'write', input.idempotencyKey)
    const existing = this.store.queue.outboxRecord(ids.operationId)
    if (existing) {
      const sameTarget =
        existing.targetRef.repoId === input.target.repoId &&
        existing.targetRef.number === input.target.number
      const hash = 'intentHash' in existing ? existing.intentHash : null
      if (
        !sameTarget ||
        existing.sourceId !== input.sourceId ||
        existing.issueId !== input.issueId ||
        existing.mandateId !== input.mandateId ||
        digest(JSON.stringify(intent)) !== hash
      )
        throw new GithubWriteFault('external_write_idempotency_conflict')
      return externalOutboxSummary(existing)
    }
    const { source, bound } = checkBoundWrite(
      this.store,
      actor,
      { ...input, intent },
      this.statusGateConfirmed,
    )
    const resultReply = intent.action === 'comment' && intent.purpose === 'result'
    if (
      resultReply &&
      !this.store.resultReplies.matches(actor.managerId, input.issueId, source.sourceId, bound)
    )
      throw new GithubWriteFault('external_result_reply_requires_original_subject')
    const entry = this.prepare(actor, ids, source, bound, intent)
    return externalOutboxSummary(
      this.store.queue.enqueueOutbox({
        ...entry,
        issueId: input.issueId,
        mandateId: input.mandateId,
        ...(resultReply ? { resultReply: true as const } : {}),
      }).record,
    )
  }

  /** C 将结果放入 commitTriage 的 reply 参数，在同库完成处置与入队。 */
  prepareTriageReply(
    actor: ExternalManagerActor,
    intakeId: string,
    idempotencyKey: string,
    body: string,
  ): NewExternalOutboxRecord | { notQueued: string } {
    if (actor.kind !== 'manager' || !activeManager(this.store, actor))
      throw new GithubWriteFault('external_write_forbidden')
    const intake = this.store.intake(intakeId)
    if (!intake || intake.managerId !== actor.managerId)
      throw new GithubWriteFault('external_reply_intake_unavailable')
    const intent = normalizedIntent({ action: 'comment', body })
    const ids = this.ids(actor, `triage:${intakeId}`, idempotencyKey)
    const existing = this.store.queue.outboxRecord(ids.operationId)
    if (existing) {
      const hash = 'intentHash' in existing ? existing.intentHash : null
      if (digest(JSON.stringify(intent)) !== hash || existing.intakeId !== intakeId)
        throw new GithubWriteFault('external_write_idempotency_conflict')
      return existing
    }
    try {
      const { source } = sourceAndRepo(this.store, intake.sourceId, intake.subject)
      assertAction(source, 'comment')
      return this.prepare(actor, ids, source, intake.subject, intent)
    } catch (error) {
      if (error instanceof GithubWriteFault) return { notQueued: error.code }
      throw error
    }
  }

  get(actor: ExternalManagerActor, operationId: string): ExternalOutboxSummary | null {
    const entry = this.store.queue.outboxRecord(operationId)
    return actor.kind === 'manager' &&
      activeManager(this.store, actor) &&
      entry?.managerId === actor.managerId
      ? externalOutboxSummary(entry)
      : null
  }

  /** H 只在通过设备管理员权限后调用；命令本身不允许取消已开始发送的操作。 */
  cancel(
    operationId: string,
    expectedRevision: number,
    actorId: string,
  ): ExternalOutboxSummary | null {
    const result = this.store.queue.cancelOutbox(operationId, expectedRevision, actorId, this.now())
    return result.record && externalOutboxSummary(result.record)
  }

  /** H 在恢复或定时循环调用。过期租约只转 unknown，不自动回到待发。 */
  async tick(limit = 10): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const at = this.now()
      if (at >= this.nextSweep) {
        this.nextSweep = at + 3600
        this.sweepPayloads(at)
      }
      this.store.queue.expireWriteLeases(at)
      for (const entry of this.store.unknownWritesDue(at, limit)) {
        if (at > this.reconcileUntil(entry))
          this.store.deferUnknownWrite(
            entry.operationId,
            entry.revision,
            at,
            null,
            'external_write_manual_confirmation_required',
          )
        else await this.reconcile(entry.operationId)
      }
      for (const entry of this.store.queue.readyOutbox(this.now(), limit)) await this.trySend(entry)
    } finally {
      this.ticking = false
    }
  }

  /** 单项只读核对；暂停时也允许用同机器人在仍配置的仓库中查证。 */
  async reconcile(operationId: string): Promise<{
    receipt: ExternalOutboxSummary['receipt'] | null
    diagnostics: ExternalDiagnostic[]
  }> {
    const entry = this.store.queue.outboxRecord(operationId)
    if (entry?.receipt) return { receipt: entry.receipt, diagnostics: [] }
    if (entry?.state !== 'unknown' || this.running.has(operationId))
      return {
        receipt: null,
        diagnostics: [
          {
            check: 'write_reconcile',
            state: 'unverified',
            code: 'external_write_not_ready_to_reconcile',
          },
        ],
      }
    this.running.add(operationId)
    let code = 'github_write_no_proof'
    try {
      const source = this.store.config.source(entry.sourceId)
      const repo = source?.repos.find((value) => value.repoId === entry.targetRef.repoId)
      if (!source || !repo) throw new GithubWriteFault('external_source_not_available')
      const context = this.context(entry, source, repo, 'lookup')
      const lookup = await lookupGithubWrite(
        context,
        this.payloads.platformId(operationId) ?? undefined,
      )
      if (lookup) {
        context.beforeDispatch()
        const result = this.confirm(entry, lookup)
        if (result?.receipt) return { receipt: result.receipt, diagnostics: [] }
        code = 'external_write_binding_conflict'
      }
    } catch (error) {
      code = error instanceof GithubWriteFault ? error.code : 'external_reconcile_unavailable'
    } finally {
      this.running.delete(operationId)
    }
    const now = this.now()
    const until = this.reconcileUntil(entry)
    if (now >= until) code = 'external_write_manual_confirmation_required'
    this.store.deferUnknownWrite(
      operationId,
      entry.revision,
      now,
      now >= until ? null : Math.min(now + 30, until),
      code,
    )
    return { receipt: null, diagnostics: [{ check: 'write_reconcile', state: 'unverified', code }] }
  }

  /** B/H 在 PR 正式绑单前用准确的 head/base/作者暂挂活动。 */
  pendingDraft(
    input: {
      sourceId: string
      repoId: string
      head: string
      base: string
      botUserId: string
    },
    includeConfirmed = false,
  ): string | null {
    for (const entry of this.store.externalWritesForRepo(input.sourceId, input.repoId, 'draft_pr', [
      'sending',
      'unknown',
      ...(includeConfirmed ? ['confirmed' as const] : []),
    ])) {
      try {
        const payload = this.payloads.get(entry.payloadRef, entry.payloadHash)
        if (
          payload.action === 'draft_pr' &&
          payload.head === input.head &&
          payload.base === input.base &&
          payload.botUserId === input.botUserId
        )
          return entry.operationId
      } catch {
        /* 不能把不匹配或缺失的材料当证据。 */
      }
    }
    return null
  }

  private async trySend(queued: ExternalOutboxRecord): Promise<void> {
    if (this.feedback.waitForOriginal(queued)) return
    const at = this.now()
    const started = this.store.queue.beginWrite(
      queued.operationId,
      queued.revision,
      at,
      at + LEASE_SECONDS,
    )
    if (started.outcome !== 'applied') return
    const entry = started.record
    let dispatched = false
    let credential: GithubCredentialSnapshot | undefined
    try {
      const { source, repo } = isGithubFeedbackAction(entry.action)
        ? this.feedback.check(
            entry.sourceId,
            entry.managerId,
            entry.targetRef,
            entry.policyRevision,
          )
        : recheckQueuedWrite(this.store, entry, this.statusGateConfirmed)
      const context = this.context(entry, source, repo, 'send')
      credential = context.credential
      const prepared = await prepareGithubWrite(context)
      const send: GithubSender = (token, path, options) => {
        if (!options?.post) throw new GithubWriteFault('github_write_request_invalid')
        return context.send(token, path, {
          ...options,
          beforeDispatch: () => {
            context.beforeDispatch()
            dispatched = true
          },
        })
      }
      const written = await sendPreparedGithubWrite({ ...context, send }, prepared)
      // 暂停、撤销与轮换阻止尚未发出的写入；已发出且有可靠回执仍要入账。
      this.confirm(entry, written)
    } catch (error) {
      if (
        dispatched &&
        credential &&
        isGithubFeedbackAction(entry.action) &&
        error instanceof GithubWriteFault &&
        error.code === 'github_permission_denied'
      )
        this.secrets.noteFeedbackWriteDenied(
          credential,
          entry.targetRef.repoId,
          entry.targetRef.kind,
        )
      this.store.queue.finishWrite(
        entry.operationId,
        entry.attempts,
        this.classify(entry, error, dispatched),
      )
    }
  }

  private context(
    entry: ExternalOutboxRecord,
    source: ExternalSource,
    repo: ExternalRepo,
    mode: 'send' | 'lookup',
  ): GithubWriteContext {
    const payload = this.payloads.get(entry.payloadRef, entry.payloadHash)
    if (String(payload.action) !== entry.action)
      throw new GithubWriteFault('external_write_identity_changed')
    const credential = this.secrets.active(payload.credentialRef, repo.repoId)
    if (credential.metadata.botUserId !== payload.botUserId)
      throw new GithubWriteFault('external_write_identity_changed')
    return {
      entry,
      repo,
      payload,
      credential,
      ...(payload.action === 'ack_comment_update'
        ? {
            ackCommentId: this.feedback.originalCommentId(
              entry,
              payload.createKey,
              payload.botUserId,
            ),
          }
        : {}),
      now: this.now,
      send: async (...args) => {
        try {
          return await this.send(...args)
        } catch (error) {
          this.secrets.invalidate(credential.metadata, error)
          throw error
        }
      },
      rememberPlatformId: (id) => this.payloads.notePlatformId(entry.operationId, id),
      beforeDispatch: () => {
        if (mode === 'send') {
          if (isGithubFeedbackPayload(payload)) this.feedback.recheck(entry, credential)
          else {
            recheckQueuedWrite(this.store, entry, this.statusGateConfirmed)
            if (this.assignedIdentity(entry.managerId, repo.repoId) !== payload.botUserId)
              throw new GithubWriteFault('external_write_identity_changed')
          }
        } else if (this.store.config.source(entry.sourceId)?.revision !== source.revision)
          throw new GithubWriteFault('external_write_policy_changed')
        if (!this.secrets.isCurrent(credential.metadata))
          throw new GithubWriteFault('github_credential_generation_changed')
        const current = this.store.queue.outboxRecord(entry.operationId)
        if (
          !current ||
          current.revision !== entry.revision ||
          current.state !== (mode === 'send' ? 'sending' : 'unknown') ||
          (mode === 'send' && (current.leaseUntil ?? 0) <= this.now())
        )
          throw new GithubWriteFault('external_write_lease_lost')
      },
    }
  }

  private reconcileUntil(entry: ExternalOutboxRecord): number {
    const last = this.store.queue.writeAttempts(entry.operationId).at(-1)
    return (last?.finishedAt ?? this.now()) + RECONCILE_SECONDS
  }

  private sweepPayloads(at: number): void {
    try {
      this.payloads.sweep(at - PAYLOAD_KEEP_SECONDS, (operationId, key) => {
        const entry = this.store.queue.outboxRecord(operationId)
        return (
          !!entry &&
          ['queued', 'sending', 'unknown'].includes(entry.state) &&
          (key === entry.payloadRef || key === `lookup-${operationId}`)
        )
      })
    } catch {
      /* 待发清扫失败不影响发送和对账，下轮窗口再清扫。 */
    }
  }

  private confirm(entry: ExternalOutboxRecord, value: GithubWritten): ExternalOutboxRecord | null {
    const result = this.store.queue.finishWrite(
      entry.operationId,
      entry.attempts,
      {
        outcome: 'confirmed',
        at: this.now(),
        receipt: value.receipt,
        ...(value.receipt.requestId ? { requestId: value.receipt.requestId } : {}),
      },
      value.prRef,
    )
    // 确认后不再需要待发正文。删失败由保留期清扫处理，不影响已提交的回执。
    if (result.outcome === 'applied') {
      try {
        this.payloads.purge(entry.payloadRef, entry.operationId)
      } catch {
        /* 稍后清理。 */
      }
    }
    return result.record
  }

  private classify(
    entry: ExternalOutboxRecord,
    error: unknown,
    dispatched: boolean,
  ): ExternalWriteCompletion {
    const at = this.now()
    const fault =
      error instanceof GithubWriteFault ? error : new GithubWriteFault('external_write_unavailable')
    const errorClass = fault.code
    const failure = { at, errorClass, ...(fault.requestId ? { requestId: fault.requestId } : {}) }
    const retryable =
      fault.code === 'github_rate_limited' ||
      (!dispatched &&
        [
          'github_transport_unknown',
          'github_request_unknown',
          'github_credential_generation_changed',
        ].includes(fault.code))
    if (retryable && entry.attempts < MAX_ATTEMPTS)
      return {
        ...failure,
        outcome: 'retryable',
        nextAttempt: Math.max(at + 15 * 2 ** entry.attempts, fault.retryAt ?? 0),
      }
    if (dispatched && !retryable && ![401, 403, 404, 422].includes(fault.status ?? 0))
      return { ...failure, outcome: 'unknown' }
    if (retryable || fault.status === 422) return { ...failure, outcome: 'failed' }
    return { ...failure, outcome: 'blocked' }
  }

  private ids(actor: ExternalManagerActor, scope: string, key: string) {
    if (!privateName(key)) throw new GithubWriteFault('external_write_idempotency_key_invalid')
    const fingerprint = digest(JSON.stringify([actor.managerId, scope, key])).slice(0, 48)
    return { operationId: `ghw-${fingerprint}`, idempotencyKey: `github:${fingerprint}` }
  }

  private assignedIdentity(managerId: string, repoId: string): string {
    const assigned = this.assignmentForManager(managerId)
    if (!assigned?.identityId || !assigned.repoIds.includes(repoId))
      throw new GithubWriteFault('external_write_identity_not_assigned')
    return assigned.identityId
  }

  private prepare(
    actor: ExternalManagerActor,
    ids: ReturnType<ExternalGithubOutbox['ids']>,
    source: ExternalSource,
    targetRef: ExternalSubject,
    intent: ExternalWriteIntent,
  ): TrackedWrite {
    const identity = this.assignedIdentity(actor.managerId, targetRef.repoId)
    const credential = this.secrets.activeForRepository(targetRef.repoId, identity)
    const { provider, repoId, number, kind, url } = targetRef
    return {
      ...ids,
      sourceId: source.sourceId,
      managerId: actor.managerId,
      actorThreadId: actor.threadId,
      action: intent.action,
      policyRevision: source.revision,
      intentHash: digest(JSON.stringify(intent)),
      targetRef: { provider, repoId, number, kind, url },
      ...this.payloads.save(ids.operationId, {
        ...intent,
        botUserId: credential.metadata.botUserId,
        credentialRef: credential.metadata.credentialRef,
      }),
    }
  }
}
