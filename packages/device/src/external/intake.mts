// B 线先提交采集页，再由设备按程序判定收件箱和提醒；源码正文不进入账本。
import { randomUUID } from 'node:crypto'
import {
  type ExternalEvent,
  type ExternalInboxEvent,
  type ExternalRepo,
  type ExternalSource,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import { isExternalEvent } from '../../../protocol/src/external-validation.mjs'
import type { ManagerIssue } from '../../../protocol/src/manager-issues.mjs'
import type { ExternalStore, NewExternalInboxEvent } from '../external-store.mjs'
import type { ExternalFeedback, FeedbackWaitReason } from './feedback.mjs'
import type { GithubEvidenceStore } from './github/poll-evidence-store.mjs'
import type { GithubScope } from './github/poll-state.mjs'
import type { RecheckExternalEvent } from './mandate.mjs'
import type { createGithubExternalVerification } from './mandate-github.mjs'
import {
  checkRequester,
  configuredAddresses,
  type ExternalRoutingConfig,
  type ExternalRoutingPolicy,
  explicitTrigger,
  isExternalContent,
  isHumanFollowUp,
  isLocalBot,
  isStatus,
  isTriggerWithdrawal,
  type RoleLookup,
  repositoryRouting,
  routeManagerMatches,
  selectRoute,
} from './routing.mjs'

export const NOTIFY_TTL = 24 * 60 * 60
const ROLE_RETRY_TTL = 15 * 60
const ROLE_FAULTS = new Set([
  'authentication',
  'permission',
  'not-found',
  'repository-changed',
  'disabled',
  'primary-rate',
  'secondary-rate',
  'transient',
  'invalid-response',
  'source_paused',
  'role_lookup_failed',
])
export type ReminderCategory = 'triage' | 'human' | 'status'
type QueueReminder = (event: ExternalInboxEvent, category: ReminderCategory, at: number) => string
type IntakeFeedback = {
  service: ExternalFeedback
  waitReason(groupId: string, at: number): FeedbackWaitReason
}

export function issuedLink(repo: ExternalRepo, event: ExternalEvent): boolean {
  const { subject, run } = event.targetEvidence
  const prefix = `https://github.com/${repo.owner}/${repo.name}`.toLowerCase()
  const path = `${prefix}/${subject.kind === 'issue' ? 'issues' : 'pull'}/${subject.number}`
  if (subject.url.toLowerCase() !== path) return false
  const [link, fragment, ...extra] = event.permalink.split('#')
  if (extra.length) return false
  if (event.kind === 'ci' && run && !fragment) {
    const runPath = `${prefix}/actions/runs/${run.runId}`
    if (
      link?.toLowerCase() === runPath ||
      link?.toLowerCase() === `${runPath}/attempts/${run.attempt}`
    )
      return true
  }
  return (
    link?.toLowerCase() === path &&
    (fragment === undefined ||
      new RegExp(
        `^(issuecomment|pullrequestreview|discussion_r|event)-?${event.targetEvidence.sourceEventId}$`,
      ).test(fragment))
  )
}

export function boundIssue(store: ExternalStore, managerId: string, issueId: string) {
  const issue = store.manager.issue(managerId, issueId) as ManagerIssue | null
  const meta = store.manager.issueMeta(managerId, issueId) as Pick<ManagerIssue, 'followUp'> | null
  return issue && { ...issue, followUp: meta?.followUp ?? issue.followUp }
}

export const isTerminalIssue = (issue: ManagerIssue) =>
  issue.status === 'resolved' || issue.status === 'closed'

export function evidenceWithdrawn(
  store: ExternalStore,
  row: ExternalInboxEvent,
  event: ExternalEvent,
): boolean {
  if (store.observationUnavailable(row)) return true
  const target = event.targetEvidence
  const contents = {
    issue: 'issue',
    pull_request: 'pull',
    comment: 'issue-comment',
    review: 'review',
    review_comment: 'review-comment',
  } as const
  if (event.kind in contents && event.contentVersion) {
    const objectKey = `${row.subject.number}/${contents[event.kind as keyof typeof contents]}/${row.sourceEventId}`
    const current = store.latestObservation(row.sourceId, row.subject.repoId, objectKey)
    if (
      current?.contentHash &&
      current.updatedAt >= row.occurredAt &&
      !event.contentVersion.endsWith(`/${current.contentHash}`)
    )
      return true
  }
  return store.laterEventEvidence(row).some((later) => {
    const next = later.targetEvidence
    if (event.kind === 'assigned')
      return later.kind === 'unassigned' && next.assigneeUserId === target.assigneeUserId
    if (event.kind === 'review_requested')
      return (
        later.kind === 'review_request_removed' && next.reviewerUserId === target.reviewerUserId
      )
    if (event.kind === 'labeled')
      return (
        later.kind === 'unlabeled' &&
        (next.labelId && target.labelId
          ? next.labelId === target.labelId
          : !!next.labelName && next.labelName.toLowerCase() === target.labelName?.toLowerCase())
      )
    return (
      later.kind === event.kind &&
      next.sourceEventId === target.sourceEventId &&
      later.contentVersion !== event.contentVersion
    )
  })
}

export class ExternalIntakeService {
  private readonly store: ExternalStore
  private readonly lookupGithubRole: RoleLookup
  private readonly queue: QueueReminder
  private readonly recheckEvent: RecheckExternalEvent
  private readonly configuration: ExternalRoutingPolicy
  private readonly feedback: IntakeFeedback | undefined
  private readonly inFlight = new Map<string, Promise<ExternalInboxEvent | null>>()
  private readonly retryAt = new Map<string, number>()
  private readonly retryBefore = new Map<string, number>()
  constructor(
    store: ExternalStore,
    lookupGithubRole: RoleLookup,
    queue: QueueReminder,
    recheckEvent: RecheckExternalEvent,
    configuration: ExternalRoutingPolicy,
    feedback?: IntakeFeedback,
  ) {
    this.store = store
    this.lookupGithubRole = lookupGithubRole
    this.queue = queue
    this.recheckEvent = recheckEvent
    this.configuration = configuration
    this.feedback = feedback
  }

  /** 先一次转存一个有界采集批次，再分类；同页的撤销先入账，不能被先前动作漏掉。 */
  async consumeGithub(
    evidence: GithubEvidenceStore,
    scope: GithubScope,
    at: number,
    verification: Pick<
      ReturnType<typeof createGithubExternalVerification>,
      'inspectSubject' | 'snapshotLabels'
    >,
    observeAgentPr?: (sourceId: string, event: ExternalEvent) => Promise<boolean>,
  ): Promise<void> {
    const source = this.store.config.source(scope.sourceId)
    const repo = source?.repos.find((item) => item.repoId === scope.repoId)
    if (!source?.enabled || !repo) return
    const owner = this.store.config.owner('github')
    const routing = repositoryRouting(this.configuration(), repo.repoId)
    const addresses = configuredAddresses(routing)
    const accepted: ExternalEvent[] = []
    for (const {
      value: { event, observedAt },
    } of evidence.pending(scope)) {
      let agent: 'marker' | 'head' | undefined
      let addressedBotIds: readonly string[] = []
      if (
        isExternalContent(event) &&
        !isLocalBot(routing, event.actorEvidence?.userId) &&
        ((source.triggers.mention && addresses.length > 0) ||
          event.actorEvidence?.userId === owner?.userId)
      ) {
        const proof = await this.recheckEvent({ source, repo, event, addresses })
        if (
          proof?.event.externalEventKey === event.externalEventKey &&
          proof?.event.contentVersion === event.contentVersion &&
          proof.event.actorEvidence?.userId === event.actorEvidence?.userId
        ) {
          addressedBotIds = proof.addressedBotIds
          if (proof.agentMarked) agent = 'marker'
        }
      }
      if (
        !agent &&
        event.kind === 'pull_request' &&
        event.actorEvidence?.userId &&
        !isLocalBot(routing, event.actorEvidence.userId) &&
        !this.store.ref(event.targetEvidence.subject)
      ) {
        const proof = await verification.inspectSubject({
          source,
          repo,
          number: event.targetEvidence.subject.number,
          kind: 'pull_request',
        })
        if (proof?.actorUserId === event.actorEvidence.userId) {
          if (proof.agentMarked) agent = 'marker'
          else if (
            proof.head?.repoId === repo.repoId &&
            repo.headNamespace &&
            proof.head.ref.startsWith(repo.headNamespace)
          )
            agent = 'head'
        }
      }
      const missingTriggerLabel =
        event.kind === 'labeled' &&
        !event.targetEvidence.labelId &&
        !!event.targetEvidence.labelName &&
        source.triggers.label &&
        (routing.labelRoutes.length > 0 || source.triggers.labelIds.length > 0)
      const routed = missingTriggerLabel
        ? await verification.snapshotLabels(source, repo, event)
        : event
      const row = this.preparePollEvent(
        source.sourceId,
        routed,
        observedAt,
        routing,
        addressedBotIds,
        agent,
      )
      this.store.transaction(() => {
        if (
          this.store.config.source(scope.sourceId)?.revision !== source.revision ||
          this.store.config.owner('github')?.revision !== owner?.revision ||
          this.configuration().revision !== routing.revision
        )
          return
        const record = evidence.settle(
          scope,
          event.externalEventKey,
          row ? { status: 'received', ...(row.reason ? { reason: row.reason } : {}) } : 'ignore',
        )
        if (record) {
          if (record.status === 'received' && record.revision === 1)
            this.store.recordRoutingEvidence(record, {
              addressedBotIds,
              ...(routed.targetEvidence.labelIds
                ? { labelIds: routed.targetEvidence.labelIds }
                : {}),
              ...(!event.targetEvidence.labelId && routed.targetEvidence.labelId
                ? { resolvedLabelId: routed.targetEvidence.labelId }
                : {}),
            })
          accepted.push(event)
        }
      })
    }
    for (const event of accepted) {
      if (
        observeAgentPr &&
        event.kind === 'pull_request' &&
        isLocalBot(routing, event.actorEvidence?.userId)
      )
        await observeAgentPr(source.sourceId, event).catch(() => false)
      await this.process(event.externalEventKey, at)
    }
  }

  /** 与 commitPollPage 同步使用；普通未绑定事件只写采集观察与水位。 */
  preparePollEvent(
    sourceId: string,
    event: ExternalEvent,
    observedAt: number,
    routing: ExternalRoutingConfig,
    addresses: readonly string[],
    agent?: 'marker' | 'head',
  ): NewExternalInboxEvent | null {
    const source = this.store.config.source(sourceId)
    if (
      !source ||
      !isExternalEvent(event) ||
      event.subjectKey !== externalSubjectKey(event.targetEvidence.subject)
    )
      return null
    const target = event.targetEvidence
    const repo = source.repos.find((one) => one.repoId === target.subject.repoId)
    if (!repo || !issuedLink(repo, event)) return null
    const ref = this.store.ref(target.subject)
    const trigger = explicitTrigger(source, event, routing, addresses)
    const agentPull =
      event.kind === 'pull_request' &&
      (isLocalBot(routing, event.actorEvidence?.userId) || agent !== undefined)
    const withdrawal =
      event.kind === 'unassigned'
        ? isLocalBot(routing, target.assigneeUserId)
        : event.kind === 'review_request_removed'
          ? isLocalBot(routing, target.reviewerUserId)
          : event.kind === 'unlabeled' &&
            (routing.labelRoutes.some((route) => route.labelId === target.labelId) ||
              source.triggers.labelIds.includes(target.labelId ?? '') ||
              (routing.labelRoutes.length > 0 && !!target.labelName) ||
              target.labelName?.toLowerCase() === 'litch')
    if (
      !trigger &&
      !withdrawal &&
      !agentPull &&
      !(ref && (isHumanFollowUp(event) || isStatus(event)))
    )
      return null
    if (
      isLocalBot(routing, event.actorEvidence?.userId) &&
      event.kind !== 'ci' &&
      !withdrawal &&
      !agentPull
    )
      return null
    return {
      eventKey: event.externalEventKey,
      sourceId,
      subjectKey: event.subjectKey,
      subject: target.subject,
      kind: event.kind,
      sourceEventId: target.sourceEventId,
      actorId: event.actorEvidence?.userId ?? null,
      actorRoleAtCheck: null,
      occurredAt: event.occurredAt,
      observedAt,
      status: 'received',
      ...(agent ? { reason: agent === 'marker' ? 'agent_origin_hint' : 'agent_pr_head_hint' } : {}),
      eventUrl: event.permalink,
      contentVersion: event.contentVersion,
      evidence: event,
    }
  }

  /** 重启可从 received 恢复；单次扫描分页，网络操作不持有 SQLite 事务。 */
  async processReceived(sourceId: string, at: number): Promise<void> {
    const page = this.store.unclassifiedInbox(sourceId, this.retryBefore.get(sourceId))
    if (page.nextBeforeSeq === null) this.retryBefore.delete(sourceId)
    else this.retryBefore.set(sourceId, page.nextBeforeSeq)
    for (const row of page.entries) await this.process(row.eventKey, at)
  }

  process(eventKey: string, at: number): Promise<ExternalInboxEvent | null> {
    const existing = this.inFlight.get(eventKey)
    if (existing) return existing
    const job = this.classify(eventKey, at).finally(() => this.inFlight.delete(eventKey))
    this.inFlight.set(eventKey, job)
    return job
  }

  private async classify(eventKey: string, at: number): Promise<ExternalInboxEvent | null> {
    const row = this.store.inboxEvent(eventKey)
    if (!row || row.status !== 'received' || row.reason === 'awaiting_delivery') return row
    const source = this.store.config.source(row.sourceId)
    const proof = this.store.routingEvidence(row)
    const event = proof?.event
    const repo = source?.repos.find((one) => one.repoId === row.subject.repoId)
    if (!source || !repo || !proof || !event || !issuedLink(repo, event))
      return this.patch(row, { status: 'blocked', reason: 'evidence_or_scope_invalid' })
    if (!source.enabled) return row
    const owner = this.store.config.owner('github')
    const credential = this.store.config.credential(source.credentialRef)
    const routing = repositoryRouting(this.configuration(), repo.repoId)
    const trigger = explicitTrigger(source, event, routing, proof.addressedBotIds)
    const ref = this.store.ref(row.subject)
    const status = isStatus(event)
    if (isTriggerWithdrawal(event))
      return this.patch(row, { status: 'processed', reason: 'trigger_withdrawn' })
    const agentPull =
      event.kind === 'pull_request' &&
      (isLocalBot(routing, row.actorId) ||
        ['agent_origin_hint', 'agent_pr_head_hint'].includes(row.reason ?? ''))
    if (agentPull) return this.agentPull(row, routing)
    if (!trigger && !(ref && (isHumanFollowUp(event) || status)))
      return this.patch(row, { status: 'processed', reason: 'no_trigger' })
    if (isLocalBot(routing, row.actorId) && event.kind !== 'ci')
      return this.patch(row, { status: 'processed', reason: 'robot_action' })
    if (evidenceWithdrawn(this.store, row, event))
      return this.patch(row, { status: 'blocked', reason: 'evidence_withdrawn' })
    const edited = event.targetEvidence.publication === 'edited'
    if (edited || (trigger === 'mention' && event.targetEvidence.publication !== 'published'))
      return this.patch(row, {
        ...(ref ? { managerId: ref.managerId, issueId: ref.issueId } : {}),
        ...(trigger ? { ruleId: trigger, rulesVersion: source.rulesVersion } : {}),
        status: 'blocked',
        reason: edited ? 'edited_content' : 'publication_unverified',
      })

    const deadline = row.observedAt + ROLE_RETRY_TTL
    if (!status && (this.retryAt.get(eventKey) ?? 0) > at && at < deadline) return row
    if (at >= deadline && row.reason?.startsWith('role_lookup_pending:')) {
      this.retryAt.delete(eventKey)
      return this.patch(row, {
        status: 'blocked',
        reason: row.reason.replace('pending:', 'failed:'),
      })
    }
    if (row.reason === 'agent_origin_hint')
      return this.patch(row, {
        status: 'processed',
        reason: 'agent_action',
        ...(ref ? { managerId: ref.managerId, issueId: ref.issueId } : {}),
      })
    if (
      row.actorId &&
      row.actorId === owner?.userId &&
      (trigger === 'mention' || isHumanFollowUp(event))
    ) {
      const proof = await this.recheckEvent({
        source,
        repo,
        event,
        addresses: configuredAddresses(routing),
      })
      if (proof?.agentMarked) {
        if (event.kind === 'pull_request') return this.agentPull(row, routing)
        return this.patch(row, {
          status: 'processed',
          reason: 'agent_action',
          ...(ref ? { managerId: ref.managerId, issueId: ref.issueId } : {}),
        })
      }
      if (
        !proof ||
        proof.event.contentVersion !== event.contentVersion ||
        proof.event.actorEvidence?.userId !== row.actorId
      ) {
        if (at >= deadline)
          return this.patch(row, { status: 'blocked', reason: 'owner_origin_unverified' })
        this.retryAt.set(eventKey, Math.min(deadline, at + 30))
        return this.patch(row, { reason: 'owner_origin_pending' })
      }
    }
    const identity = status
      ? null
      : await checkRequester(
          source,
          repo,
          event.actorEvidence,
          owner?.userId,
          routing,
          this.lookupGithubRole,
        )
    return this.store.transaction(() => {
      const latest = this.store.inboxEvent(eventKey)
      if (!latest || latest.revision !== row.revision) return latest
      if (
        this.store.config.source(row.sourceId)?.revision !== source.revision ||
        this.store.config.owner('github')?.revision !== owner?.revision ||
        this.configuration().revision !== routing.revision ||
        this.store.config.credential(source.credentialRef)?.generation !== credential?.generation ||
        JSON.stringify(this.store.ref(row.subject)) !== JSON.stringify(ref)
      )
        return latest
      const base = {
        ...(ref ? { managerId: ref.managerId, issueId: ref.issueId } : {}),
        ruleId: trigger ?? (status ? 'bound_status' : 'bound_follow_up'),
        rulesVersion: source.rulesVersion,
      }
      if (identity && 'reason' in identity) {
        const failure =
          identity.reason === 'role_unavailable' && ROLE_FAULTS.has(identity.failure)
            ? identity.failure
            : undefined
        if (identity.reason === 'role_unavailable' && at < deadline) {
          this.retryAt.set(eventKey, Math.min(deadline, Math.max(at + 30, identity.retryAt ?? 0)))
          return this.patch(row, {
            ...base,
            reason: `role_lookup_pending:${failure ?? 'unverified'}`,
          })
        }
        this.retryAt.delete(eventKey)
        return this.patch(row, {
          ...base,
          status: 'blocked',
          reason: failure ? `role_lookup_failed:${failure}` : identity.reason,
        })
      }
      this.retryAt.delete(eventKey)
      if (evidenceWithdrawn(this.store, row, event))
        return this.patch(row, { ...base, status: 'blocked', reason: 'evidence_withdrawn' })
      const patch = { ...base, actorRoleAtCheck: identity?.role ?? null }
      if (identity && !identity.eligible)
        return this.patch(row, { ...patch, status: 'blocked', reason: 'role_below_threshold' })
      if (ref) {
        const issue = boundIssue(this.store, ref.managerId, ref.issueId)
        const manager = this.store.manager.manager(ref.managerId)
        if (!issue || !routeManagerMatches(manager, repo))
          return this.patch(row, { ...patch, status: 'processed', reason: 'bound_target_inactive' })
        if (isTerminalIssue(issue) && trigger)
          return this.collect(row, { ...patch, reason: 'terminal_issue' }, at, false)
        const followUpOff =
          issue.followUp.state !== 'on' ||
          this.store.issueFollowUpOffAt(ref.managerId, ref.issueId, row.observedAt)
        if (isTerminalIssue(issue) || followUpOff || event.kind === 'reopened')
          return this.patch(row, {
            ...patch,
            status: 'processed',
            reason: isTerminalIssue(issue)
              ? 'terminal_issue'
              : followUpOff
                ? 'follow_up_off'
                : 'external_reopened',
          })
        if (at >= row.occurredAt + NOTIFY_TTL)
          return this.patch(row, { ...patch, status: 'processed', reason: 'notify_expired' })
        const queued = this.patch(row, { ...patch, reason: 'awaiting_delivery' })
        const category = status ? 'status' : 'human'
        const groupId = this.queue(queued, category, at)
        this.feedback?.service.received(queued, category, this.feedback.waitReason(groupId, at))
        return queued
      }
      const chosen = selectRoute(
        source,
        event,
        repo,
        (id) => this.store.manager.manager(id),
        routing,
        proof.addressedBotIds,
      )
      return this.collect(
        row,
        'reason' in chosen
          ? { ...patch, reason: chosen.reason }
          : {
              ...patch,
              routeId: chosen.routeId,
              managerId: chosen.managerId,
              reason: 'awaiting_triage',
            },
        at,
        'managerId' in chosen,
      )
    })
  }

  private agentPull(row: ExternalInboxEvent, routing: ExternalRoutingConfig) {
    const ref = this.store.ref(row.subject)
    const actor = routing.identities.find((identity) => identity.botUserId === row.actorId)
    const matches = routing.assignments.filter(
      (assignment) => assignment.identityId === actor?.identityId,
    )
    const target =
      matches.length === 1
        ? matches[0]
        : routing.assignments.length === 1
          ? routing.assignments[0]
          : undefined
    const managerId =
      target && this.store.manager.manager(target.managerId)?.status === 'active'
        ? target.managerId
        : undefined
    return this.patch(row, {
      status: 'processed',
      reason: ref ? 'agent_pr_bound' : 'agent_pr_needs_link',
      ...(ref
        ? { managerId: ref.managerId, issueId: ref.issueId }
        : managerId
          ? { managerId }
          : {}),
    })
  }

  private collect(
    row: ExternalInboxEvent,
    patch: Partial<ExternalInboxEvent>,
    at: number,
    auto: boolean,
  ): ExternalInboxEvent {
    const expires = row.occurredAt + NOTIFY_TTL
    const next = this.patch(row, {
      ...patch,
      ...(auto && at >= expires ? { reason: 'notify_expired' } : {}),
    })
    const intake = this.store.collectIntake({
      intakeId: randomUUID(),
      sourceId: row.sourceId,
      subjectKey: row.subjectKey,
      subject: row.subject,
      ...(next.managerId ? { managerId: next.managerId } : {}),
      ...(next.issueId ? { issueId: next.issueId } : {}),
      ...(next.reason ? { reason: next.reason } : {}),
      eventKeys: [row.eventKey],
      autoNotifyUntil: expires,
    })
    const queued = this.store.inboxEvent(row.eventKey) ?? next
    if (auto && at < expires) {
      const previous = intake.deliveryId ? this.store.queue.deliveryGroup(intake.deliveryId) : null
      // 同一待分拣已经送过或发送不明；新证据仍能从原候选读取。
      if (!previous || previous.state === 'queued' || previous.state === 'blocked') {
        const group = this.queue(queued, 'triage', at)
        if (intake.deliveryId !== group)
          this.store.updateIntakeDelivery(intake.intakeId, intake.revision, group)
        this.feedback?.service.received(queued, 'triage', this.feedback.waitReason(group, at))
      } else {
        this.feedback?.service.received(queued, 'triage', 'queued', false)
      }
    }
    return queued
  }

  private patch(row: ExternalInboxEvent, patch: Partial<ExternalInboxEvent>): ExternalInboxEvent {
    if (
      Object.entries(patch).every(([key, value]) => row[key as keyof ExternalInboxEvent] === value)
    )
      return row
    return this.store.updateInboxEvent(row.eventKey, row.revision, patch).record ?? row
  }
}
