// 设备复核外部证据，再在本地事务内检查版本与归属。网络等待不占写事务。
import type {
  ExternalAnswerSource,
  ExternalEvent,
  ExternalInboxEvent,
  ExternalIntake,
  ExternalIssueId,
  ExternalRepo,
  ExternalSource,
  ExternalTriageParams,
  ExternalTriageResult,
} from '../../../protocol/src/external-sources.mjs'
import { isExternalEvent } from '../../../protocol/src/external-validation.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import type {
  ExternalStore,
  ExternalTriageCommit,
  ExternalTriageHooks,
} from '../external-store.mjs'
import { signature } from '../external-store-internal.mjs'
import { invalid } from '../manager-validate.mjs'
import { boundIssue, evidenceWithdrawn, issuedLink, isTerminalIssue } from './intake.mjs'
import {
  checkRequester,
  configuredAddresses,
  type ExternalRouteIdentity,
  type ExternalRoutingPolicy,
  explicitTrigger,
  isHumanFollowUp,
  isLocalBot,
  managerIdentity,
  type RoleLookup,
  repositoryRouting,
  routeManagerMatches,
  selectRoute,
} from './routing.mjs'

export interface ExternalManagerTurn {
  managerId: string
  threadId: string
  harness: string
  turnId: string
}
type Disposition = Exclude<ExternalTriageParams, { action: 'reassign' }>

export type RecheckExternalEvent = (input: {
  source: ExternalSource
  repo: ExternalRepo
  event: ExternalEvent
  addresses: readonly ExternalRouteIdentity[]
}) => Promise<{
  event: ExternalEvent
  agentMarked: boolean
  addressedBotIds: readonly string[]
} | null>

export interface ExternalMandateHost {
  now(): number
  isCurrentTurn(turn: ExternalManagerTurn): boolean
  configuration: ExternalRoutingPolicy
  lookupGithubRole: RoleLookup
  /** 只返回由原对象、当前标签/指派/review 请求及作者核验重建的证据。 */
  recheckEvent: RecheckExternalEvent
  prepareReply?(input: {
    turn: ExternalManagerTurn
    source: ExternalSource
    intake: ExternalIntake
    request: Disposition
    text: string
  }): Promise<NonNullable<ExternalTriageHooks['reply']>>
  onIssueCreated?(managerId: string, issueId: ExternalIssueId, related?: ExternalIssueId): void
  onIssueChanged?(managerId: string, issueId: ExternalIssueId, created: boolean): void
}

const actionPolicy = {
  comment: 'comment',
  draft_pr: 'draftPr',
  status: 'status',
} as const

export class ExternalMandateService {
  private readonly store: ExternalStore
  private readonly host: ExternalMandateHost
  constructor(store: ExternalStore, host: ExternalMandateHost) {
    this.store = store
    this.host = host
  }

  requireManager(turn: ExternalManagerTurn): Manager {
    const manager = this.store.manager.manager(turn.managerId)
    if (
      !manager ||
      manager.status !== 'active' ||
      manager.threadId !== turn.threadId ||
      manager.harness !== turn.harness ||
      !turn.turnId ||
      !this.host.isCurrentTurn(turn)
    )
      invalid('This operation requires the current active manager turn.')
    return manager
  }

  private snapshot(sourceId: string, repoId: string, manager: Manager) {
    const source = this.store.config.source(sourceId)
    const repo = source?.repos.find((item) => item.repoId === repoId)
    const owner = this.store.config.owner('github')
    const credential = source ? this.store.config.credential(source.credentialRef) : null
    const routing = repositoryRouting(this.host.configuration(), repoId)
    if (
      !source?.enabled ||
      !repo ||
      !routeManagerMatches(manager, repo) ||
      !credential ||
      credential.state !== 'active' ||
      credential.botUserId !== source.botUserId ||
      (credential.expiresAt !== undefined && credential.expiresAt <= this.host.now())
    )
      invalid('The external source or repository scope is unavailable.')
    return { source, repo, owner, generation: credential.generation, manager, routing }
  }

  private assertSnapshot(
    turn: ExternalManagerTurn,
    before: ReturnType<ExternalMandateService['snapshot']>,
  ) {
    const after = this.snapshot(
      before.source.sourceId,
      before.repo.repoId,
      this.requireManager(turn),
    )
    if (
      after.source.revision !== before.source.revision ||
      after.owner?.revision !== before.owner?.revision ||
      after.generation !== before.generation ||
      after.routing.revision !== before.routing.revision
    )
      invalid('External configuration changed; read the evidence and retry.')
  }

  private async live(ctx: ReturnType<ExternalMandateService['snapshot']>, row: ExternalInboxEvent) {
    const saved = this.store.routingEvidence(row)
    if (!saved || evidenceWithdrawn(this.store, row, saved.event)) return null
    const original = saved.event
    const proof = await this.host.recheckEvent({
      source: ctx.source,
      repo: ctx.repo,
      event: original,
      addresses: configuredAddresses(ctx.routing),
    })
    const checked = proof?.event
    if (
      !proof ||
      proof.agentMarked ||
      !checked ||
      !isExternalEvent(checked) ||
      !issuedLink(ctx.repo, checked) ||
      checked.externalEventKey !== original.externalEventKey ||
      checked.kind !== original.kind ||
      checked.subjectKey !== original.subjectKey ||
      checked.targetEvidence.subject.repoId !== ctx.repo.repoId ||
      checked.targetEvidence.subject.number !== original.targetEvidence.subject.number ||
      checked.targetEvidence.subject.kind !== original.targetEvidence.subject.kind ||
      checked.targetEvidence.sourceEventId !== original.targetEvidence.sourceEventId ||
      checked.actorEvidence?.userId !== original.actorEvidence?.userId ||
      checked.occurredAt !== original.occurredAt ||
      checked.contentVersion !== original.contentVersion ||
      checked.targetEvidence.publication !== original.targetEvidence.publication
    )
      return null
    return {
      original,
      checked,
      originalAddresses: saved.addressedBotIds,
      addresses: proof.addressedBotIds,
    }
  }

  private async evidence(
    ctx: ReturnType<ExternalMandateService['snapshot']>,
    intake: ExternalIntake,
  ) {
    const ref = this.store.ref(intake.subject)
    for (const key of intake.eventKeys) {
      const row = this.store.inboxEvent(key)
      if (
        !row ||
        row.intakeId !== intake.intakeId ||
        row.managerId !== ctx.manager.id ||
        row.status !== 'pending_triage' ||
        !row.rulesVersion ||
        !row.ruleId
      )
        continue
      const before = this.store.config.sourceRevision(row.sourceId, row.rulesVersion)
      const oldRepo = before?.repos.find((repo) => repo.repoId === ctx.repo.repoId)
      if (!before || oldRepo?.localRoot !== ctx.repo.localRoot) continue
      const live = await this.live(ctx, row)
      if (
        !live ||
        explicitTrigger(before, live.original, ctx.routing, live.originalAddresses) !==
          row.ruleId ||
        explicitTrigger(ctx.source, live.checked, ctx.routing, live.addresses) !== row.ruleId ||
        (row.ruleId === 'mention' && live.checked.targetEvidence.publication !== 'published')
      )
        continue
      const chosen = selectRoute(
        ctx.source,
        live.checked,
        ctx.repo,
        (id) => this.store.manager.manager(id),
        ctx.routing,
        live.addresses,
      )
      const reassigned =
        !!managerIdentity(ctx.routing, ctx.manager.id) &&
        this.store.wasIntakeReassigned(row, ctx.manager.id)
      const sameBinding = ref && row.issueId === ref.issueId && ref.managerId === ctx.manager.id
      const sameRoute =
        'routeId' in chosen && chosen.managerId === ctx.manager.id && chosen.routeId === row.routeId
      if (!sameBinding && !reassigned && !sameRoute) continue
      // 被撤换的 owner 不能以旧身份受理；新 owner 也不会自动提高旧证据的资格。
      if ((row.actorRoleAtCheck === 'owner') !== (ctx.owner?.userId === row.actorId)) continue
      const identity = await checkRequester(
        ctx.source,
        ctx.repo,
        live.checked.actorEvidence,
        ctx.owner?.userId,
        ctx.routing,
        this.host.lookupGithubRole,
      )
      if (!('role' in identity) || !identity.eligible || !live.checked.actorEvidence) continue
      const allowed = (Object.keys(actionPolicy) as Array<keyof typeof actionPolicy>).filter(
        (action) =>
          before.writePolicy[actionPolicy[action]] &&
          ctx.source.writePolicy[actionPolicy[action]] &&
          (action === 'comment' ||
            action === 'status' ||
            (oldRepo.headNamespace === ctx.repo.headNamespace &&
              ctx.repo.allowedBase.every((base) => oldRepo.allowedBase.includes(base)))),
      )
      return {
        row,
        original: live.original,
        evidence: {
          requesterUserId: live.checked.actorEvidence.userId,
          observedRole: identity.role,
          eventKeys: [row.eventKey],
          ruleId: row.ruleId,
          rulesVersion: row.rulesVersion,
          routeId: sameBinding ? 'binding' : reassigned ? 'manual-reassign' : (row.routeId ?? ''),
          policyRevision: ctx.source.revision,
          authorizedScope: {
            repoId: ctx.repo.repoId,
            subjectKey: intake.subjectKey,
            actions: allowed,
          },
        },
      }
    }
    return null
  }

  async decide(turn: ExternalManagerTurn, request: Disposition): Promise<ExternalTriageResult> {
    const manager = this.requireManager(turn)
    const intake = this.store.intake(request.intakeId)
    if (!intake || intake.managerId !== manager.id)
      invalid('This intake is not assigned to the current manager.')
    const requestKey = JSON.stringify([intake.intakeId, request.idempotencyKey])
    const sig = signature(request)
    const currentResult = (): ExternalTriageResult | null => {
      this.requireManager(turn)
      const latest = this.store.intake(intake.intakeId)
      if (!latest || latest.managerId !== manager.id) invalid('The intake assignment changed.')
      const ref = this.store.ref(latest.subject)
      const conflict = (
        reason: 'intake_revision' | 'idempotency' | 'binding',
      ): ExternalTriageResult => ({
        outcome: 'conflict',
        reason,
        intake: latest,
        ...(ref ? { ref } : {}),
      })
      const replay = this.store.triageResult(intake.intakeId, request.idempotencyKey)
      if (replay)
        return this.store.manager.idempotency(manager.id, requestKey, 'external_triage') === sig
          ? replay
          : conflict('idempotency')
      if (latest.revision !== request.expectedRevision || latest.status !== 'pending_triage')
        return conflict('intake_revision')
      if (ref && ref.managerId !== manager.id) return conflict('binding')
      if (
        request.action === 'accept' &&
        ref &&
        (ref.managerId !== manager.id || request.relatedIssueId !== ref.issueId)
      )
        return conflict('binding')
      if (
        request.action === 'merge' &&
        ref &&
        (ref.managerId !== manager.id || request.issueId !== ref.issueId)
      )
        return conflict('binding')
      return null
    }
    const previous = currentResult()
    if (previous) return previous
    const ctx = this.snapshot(intake.sourceId, intake.subject.repoId, manager)
    const verified = await this.evidence(ctx, intake)
    const raced = currentResult()
    if (raced) return raced
    if (!verified)
      invalid('No original trigger still meets current evidence, identity and route requirements.')
    this.assertSnapshot(turn, ctx)
    const ref = this.store.ref(intake.subject)
    const followOn = request.action === 'accept' && !!ref
    const actions = followOn ? [] : verified.evidence.authorizedScope.actions
    const reply =
      request.reply === undefined
        ? undefined
        : !actions.includes('comment')
          ? { notQueued: 'comment_disabled' }
          : this.host.prepareReply
            ? await this.host.prepareReply({
                turn,
                source: ctx.source,
                intake,
                request,
                text: request.reply,
              })
            : { notQueued: 'reply_unavailable' }

    let committed = false
    const result = this.store.transaction(() => {
      const previous = currentResult()
      if (previous) return previous
      this.assertSnapshot(turn, ctx)
      if (
        JSON.stringify(this.store.ref(intake.subject)) !== JSON.stringify(ref) ||
        evidenceWithdrawn(this.store, verified.row, verified.original)
      )
        invalid('The evidence changed; read the intake again.')
      const target =
        request.action === 'merge' ? boundIssue(this.store, manager.id, request.issueId) : null
      if (target && (isTerminalIssue(target) || target.followUp.state !== 'on'))
        invalid('Open the merge target and enable follow-up before merging an external intake.')
      const { reply: _reply, ...disposition } = request
      const commit = {
        ...disposition,
        managerId: manager.id,
        actorId: turn.threadId,
        at: this.host.now(),
        ...(disposition.action === 'ignore'
          ? {}
          : {
              evidence: {
                ...verified.evidence,
                authorizedScope: { ...verified.evidence.authorizedScope, actions },
              },
            }),
      } as ExternalTriageCommit
      const current = this.store.commitTriage(commit, {
        ...(reply ? { reply } : {}),
        onCreate: (issue, related) =>
          this.host.onIssueCreated?.(manager.id, issue.id as ExternalIssueId, related),
      })
      if (current.outcome === 'applied') {
        this.store.manager.saveIdempotency(manager.id, requestKey, 'external_triage', sig)
        committed = true
      }
      return current
    })
    // 已经处置的重试只交回原回执，不重复广播。
    if (committed && result.outcome === 'applied' && result.mandate) {
      this.host.onIssueChanged?.(manager.id, result.mandate.issueId, request.action === 'accept')
    }
    return result
  }

  /** 不用登录名、评论正文或被提及者推断 owner。返回的提交函数必须同步完成原事务内写入。 */
  async ownerAnswer(
    turn: ExternalManagerTurn,
    eventKey: string,
    apply: (source: ExternalAnswerSource) => unknown,
  ): Promise<unknown> {
    const manager = this.requireManager(turn)
    const row = this.store.inboxEvent(eventKey)
    if (!row) invalid('Unknown owner comment evidence.')
    const ctx = this.snapshot(row.sourceId, row.subject.repoId, manager)
    if (!ctx.owner || row.actorId !== ctx.owner.userId || isLocalBot(ctx.routing, row.actorId))
      invalid('The comment is not from the configured GitHub owner.')
    const permitted = () => {
      const ref = this.store.ref(row.subject)
      const latest = this.store.inboxEvent(eventKey)
      return ref
        ? ref.managerId === manager.id
        : latest?.managerId === manager.id &&
            latest.status === 'pending_triage' &&
            latest.intakeId &&
            this.store.intake(latest.intakeId)?.managerId === manager.id
    }
    if (!permitted()) invalid('The owner comment does not belong to this manager.')
    const proof = await this.live(ctx, row)
    if (
      !proof ||
      !isHumanFollowUp(proof.checked) ||
      proof.checked.targetEvidence.publication !== 'published' ||
      !proof.checked.contentVersion
    )
      invalid('The owner comment could not be verified in its current version.')
    this.assertSnapshot(turn, ctx)
    if (!permitted() || evidenceWithdrawn(this.store, row, proof.original))
      invalid('The owner comment is no longer available to this manager.')
    return apply({
      kind: 'github',
      repoId: row.subject.repoId,
      commentId: row.sourceEventId,
      actorUserId: ctx.owner.userId,
      url: proof.checked.permalink,
      revision: proof.checked.contentVersion,
    })
  }
}
