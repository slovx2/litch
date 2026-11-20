import {
  type ExternalIssueId,
  type ExternalSource,
  type ExternalSubject,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalOutboxRecord, ExternalStore } from '../external-store.mjs'
import { GithubWriteFault, numericId } from './github/write-api.mjs'
import { type ExternalWriteIntent, validateDraftLocation } from './outbox-payload.mjs'
import { activeManager, type ExternalToolActor } from './outbox-read.mjs'

export type ExternalManagerActor = Extract<ExternalToolActor, { kind: 'manager' }>
export type ExternalWriteRequest = {
  sourceId: string
  issueId: ExternalIssueId
  target: { repoId: string; number: string }
  mandateId: string
  idempotencyKey: string
  intent: ExternalWriteIntent
}
export type StatusGateConfirmed = (source: ExternalSource) => boolean

export function sourceAndRepo(
  store: ExternalStore,
  sourceId: string,
  target: ExternalSubject,
  atRevision?: number,
) {
  const source = store.config.source(sourceId)
  const repo = source?.repos.find((row) => row.repoId === target.repoId)
  if (!source?.enabled || !repo || !numericId(target.number))
    throw new GithubWriteFault('external_source_not_available')
  if (atRevision !== undefined && source.revision !== atRevision)
    throw new GithubWriteFault('external_write_policy_changed')
  return { source, repo }
}

export function assertAction(
  source: ExternalSource,
  action: string,
  statusGateConfirmed?: StatusGateConfirmed,
): void {
  if (
    !(
      (action === 'comment' && source.writePolicy.comment) ||
      (action === 'draft_pr' && source.writePolicy.draftPr) ||
      (action === 'status' && source.writePolicy.status && statusGateConfirmed?.(source) === true)
    )
  )
    throw new GithubWriteFault('external_write_action_not_allowed')
}

export function checkBoundWrite(
  store: ExternalStore,
  actor: ExternalManagerActor,
  input: ExternalWriteRequest,
  statusGateConfirmed?: StatusGateConfirmed,
) {
  if (!activeManager(store, actor)) throw new GithubWriteFault('external_write_forbidden')
  const bound = store.ref({
    provider: 'github',
    repoId: input.target.repoId,
    number: input.target.number,
  })
  if (!bound || bound.managerId !== actor.managerId || bound.issueId !== input.issueId)
    throw new GithubWriteFault('external_write_requires_binding')
  const { source, repo } = sourceAndRepo(store, input.sourceId, bound)
  checkMandate(
    store,
    source,
    actor.managerId,
    input.issueId,
    input.mandateId,
    bound,
    input.intent.action,
  )
  assertAction(source, input.intent.action, statusGateConfirmed)
  if (input.intent.action === 'draft_pr')
    validateDraftLocation(
      repo,
      actor.managerId,
      input.issueId,
      input.intent.head,
      input.intent.base,
    )
  return { source, repo, bound }
}

function checkMandate(
  store: ExternalStore,
  source: ExternalSource,
  managerId: string,
  issueId: ExternalIssueId,
  mandateId: string,
  target: ExternalSubject,
  action: string,
): void {
  const mandate = store.mandate(mandateId)
  const targetKey = externalSubjectKey(target)
  const statusTargetMatches =
    action === 'status' &&
    target.kind === 'pull_request' &&
    store.ref(target)?.origin === 'write_receipt' &&
    mandate?.authorizedScope.subjectKey !== targetKey &&
    store
      .refs(managerId, issueId)
      .some(
        (ref) =>
          ref.repoId === target.repoId &&
          externalSubjectKey(ref) === mandate?.authorizedScope.subjectKey,
      )
  if (
    !mandate ||
    mandate.revokedAt !== undefined ||
    mandate.managerId !== managerId ||
    mandate.issueId !== issueId ||
    !store.manager.issue(managerId, issueId) ||
    (mandate.authorizedScope.subjectKey !== targetKey && !statusTargetMatches) ||
    mandate.authorizedScope.repoId !== target.repoId ||
    !mandate.authorizedScope.actions.some((allowed) => allowed === action) ||
    !mandate.eventKeys.some((key) => {
      const event = store.inboxEvent(key)
      return (
        event?.sourceId === source.sourceId &&
        event.subjectKey === mandate.authorizedScope.subjectKey
      )
    })
  )
    throw new GithubWriteFault('external_write_mandate_unavailable')
}

export function recheckQueuedWrite(
  store: ExternalStore,
  entry: ExternalOutboxRecord,
  statusGateConfirmed?: StatusGateConfirmed,
) {
  const actor = {
    kind: 'manager' as const,
    managerId: entry.managerId,
    threadId: entry.actorThreadId,
  }
  if (!activeManager(store, actor)) throw new GithubWriteFault('external_write_forbidden')
  const { source, repo } = sourceAndRepo(
    store,
    entry.sourceId,
    entry.targetRef,
    entry.policyRevision,
  )
  assertAction(source, entry.action, statusGateConfirmed)
  if (entry.intakeId) {
    const intake = store.intake(entry.intakeId)
    if (
      intake?.status !== 'processed' ||
      intake.sourceId !== entry.sourceId ||
      intake.managerId !== entry.managerId ||
      intake.subjectKey !== externalSubjectKey(entry.targetRef) ||
      entry.action !== 'comment' ||
      intake.issueId !== entry.issueId
    )
      throw new GithubWriteFault('external_reply_intake_unavailable')
    if (!entry.issueId && intake.reason === 'ignored') return { source, repo }
  }
  if (!entry.issueId || !entry.mandateId)
    throw new GithubWriteFault('external_write_mandate_unavailable')
  const ref = store.ref(entry.targetRef)
  if (
    ref?.managerId !== entry.managerId ||
    ref.issueId !== entry.issueId ||
    ref.kind !== entry.targetRef.kind
  )
    throw new GithubWriteFault('external_write_requires_binding')
  checkMandate(
    store,
    source,
    entry.managerId,
    entry.issueId,
    entry.mandateId,
    entry.targetRef,
    entry.action,
  )
  return { source, repo }
}
