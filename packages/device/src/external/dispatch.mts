// 持久投递与自动准入。外部事件不占普通会话回报的预算，也不绕过会话保护。
import { randomUUID } from 'node:crypto'
import type { ExternalInboxEvent } from '../../../protocol/src/external-sources.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import { formatSessionEvent } from '../../../protocol/src/session-tree.mjs'
import type { ExternalDeliveryGroup, ExternalStore } from '../external-store.mjs'
import type { ExternalFeedback, FeedbackWaitReason } from './feedback.mjs'
import {
  boundIssue,
  evidenceWithdrawn,
  isTerminalIssue,
  NOTIFY_TTL,
  type ReminderCategory,
} from './intake.mjs'
import {
  type ExternalRoutingPolicy,
  explicitTrigger,
  isLocalBot,
  managerIdentity,
  repositoryRouting,
  routeManagerMatches,
  selectRoute,
} from './routing.mjs'

export const EXTERNAL_WAKE_REASON = 'external_event'
const WINDOW = 15 * 60
const AGGREGATION = 30
const LIMIT_SOURCE = 5
const LIMIT_ACTOR = 3

export type ExternalAdmissionResult =
  | { outcome: 'allowed' }
  | { outcome: 'deferred'; until: number; reason: string }
  | { outcome: 'rejected'; reason: string }
export interface ExternalAdmissionInput {
  at: number
  actorIds: readonly string[]
  sourceId: string
  managerId: string
  subjectKey: string
  category: ReminderCategory
  queuedGroups: number
  inFlight: boolean
  sourceAttempts: readonly number[]
  actorAttempts: ReadonlyMap<string, readonly number[]>
}
export type ExternalAdmission = (input: ExternalAdmissionInput) => ExternalAdmissionResult

export function defaultExternalAdmission(input: ExternalAdmissionInput): ExternalAdmissionResult {
  if (input.inFlight)
    return { outcome: 'deferred', until: input.at + 1, reason: 'manager_in_flight' }
  const expires = (times: readonly number[], limit: number) => {
    const active = times.filter((at) => at > input.at - WINDOW).sort((a, b) => a - b)
    return active.length >= limit ? (active[active.length - limit] ?? input.at) + WINDOW : 0
  }
  const source = expires(input.sourceAttempts, LIMIT_SOURCE)
  const actor =
    input.category === 'triage'
      ? Math.max(
          0,
          ...[...input.actorAttempts.values()].map((times) => expires(times, LIMIT_ACTOR)),
        )
      : 0
  const until = Math.max(source, actor)
  return until
    ? {
        outcome: 'deferred',
        until,
        reason: source >= actor ? 'source_rate_limit' : 'actor_rate_limit',
      }
    : { outcome: 'allowed' }
}

export type ExternalSendResult =
  | { outcome: 'confirmed'; turnId: string }
  | { outcome: 'not_sent' }
  | { outcome: 'unknown' }
type PreparedReminder = { text: string; eventId: string }
export interface ExternalDispatchHost {
  configuration: ExternalRoutingPolicy
  feedback?: ExternalFeedback
  /** H 用实时状态区分等待忙碌、显式暂停；C 自己核算额度。 */
  feedbackWaitReason?(manager: Manager, sourceId: string): 'manager_busy' | 'paused' | null
  /** 最终发送前也要返回真：当前线程、能力确认、停止、审批/答复、后台、归档、重置和重启。 */
  canDeliver(manager: Manager, sourceId: string): boolean
  /** 与会话树共用串行列。先生成请求，再在低层发送钩子调用 beforeSend；null 取消。 */
  send(input: {
    manager: Manager
    sourceId: string
    reason: typeof EXTERNAL_WAKE_REASON
    prepare(): PreparedReminder | null
    beforeSend(prepared: PreparedReminder): (PreparedReminder & { deliveryId: string }) | null
  }): Promise<ExternalSendResult>
  now(): number
}

function category(
  group: ExternalDeliveryGroup,
  events: readonly ExternalInboxEvent[],
): ReminderCategory {
  if (!group.issueId) return 'triage'
  return events.some((event) => event.ruleId === 'bound_status') ? 'status' : 'human'
}

type Plan = {
  group: ExternalDeliveryGroup
  events: ExternalInboxEvent[]
  category: ReminderCategory
}

export class ExternalDispatch {
  private readonly store: ExternalStore
  private readonly host: ExternalDispatchHost
  private readonly admission: ExternalAdmission
  private readonly running = new Set<string>()
  private readonly last = new Map<string, { sourceId: string; humanStreak: number }>()
  constructor(
    store: ExternalStore,
    host: ExternalDispatchHost,
    admission: ExternalAdmission = defaultExternalAdmission,
  ) {
    this.store = store
    this.host = host
    this.admission = admission
  }

  queue = (event: ExternalInboxEvent, kind: ReminderCategory, at: number): string => {
    if (!event.managerId) throw new Error('没有收件经理')
    const current = this.store.queue.deliveryGroups(event.managerId, 'queued').find(
      (group) =>
        group.sourceId === event.sourceId &&
        group.subjectKey === event.subjectKey &&
        category(group, this.events(group)) === kind &&
        // 超过首事件聚合窗口的独立跟进另起一组；状态积压只保留一组。
        (kind !== 'human' || at < group.availableAt),
    )
    return this.store.queue.queueDeliveryGroup({
      groupId: current?.groupId ?? randomUUID(),
      managerId: event.managerId,
      sourceId: event.sourceId,
      subjectKey: event.subjectKey,
      ...(kind !== 'triage' && event.issueId ? { issueId: event.issueId } : {}),
      eventKeys: [event.eventKey],
      availableAt: current?.availableAt ?? at + AGGREGATION,
    }).groupId
  }

  /** 只在设备接管状态目录时调用。未知回执仍保留原 deliveryId，供引擎对账。 */
  recover(): void {
    const at = this.host.now()
    for (const manager of this.store.manager.managers()) {
      for (const group of this.store.queue.deliveryGroups(manager.id, 'sending'))
        this.store.queue.finishDelivery(group.groupId, 'unknown', at, {
          reason: 'interrupted_submission',
        })
    }
  }

  private events(group: ExternalDeliveryGroup): ExternalInboxEvent[] {
    return group.eventKeys.flatMap((key) => {
      const row = this.store.inboxEvent(key)
      return row ? [row] : []
    })
  }

  private queued(group: ExternalDeliveryGroup, at: number, update = true): Plan | null {
    const source = this.store.config.source(group.sourceId)
    const events = this.events(group)
    const sample = events[0]
    const repo = source?.repos.find((one) => one.repoId === sample?.subject.repoId)
    const kind = category(group, events)
    const block = (reason: string) => {
      if (!update) return null
      this.store.transaction(() => {
        this.store.queue.finishDelivery(group.groupId, 'blocked', at, { reason })
        for (const event of events) {
          if (event.managerId !== group.managerId) continue
          if (event.status === 'received')
            this.store.updateInboxEvent(event.eventKey, event.revision, {
              status: 'processed',
              reason,
            })
          else if (
            event.status === 'pending_triage' &&
            event.intakeId &&
            this.store.intake(event.intakeId)?.deliveryId === group.groupId
          )
            this.store.updateInboxEvent(event.eventKey, event.revision, { reason })
        }
      })
      return null
    }
    if (!source || !repo || !sample) return block('source_scope_changed')
    const routing = repositoryRouting(this.host.configuration(), repo.repoId)
    if (events.every((event) => event.occurredAt + NOTIFY_TTL <= at)) return block('notify_expired')
    if (!source.enabled) return null
    const manager = this.store.manager.manager(group.managerId)
    if (!routeManagerMatches(manager, repo)) return block('target_inactive')
    const ref = this.store.ref(sample.subject)
    if (kind !== 'triage') {
      if (ref?.managerId !== group.managerId || ref?.issueId !== group.issueId || !group.issueId)
        return block('binding_changed')
      const issue = boundIssue(this.store, group.managerId, group.issueId)
      if (!issue || isTerminalIssue(issue)) return block('terminal_issue')
      if (issue.followUp.state !== 'on') return block('follow_up_off')
    } else if (ref) return block('binding_changed')

    const owner = this.store.config.owner('github')
    const ranks = ['read', 'triage', 'write', 'maintain', 'admin']
    let active = events.filter((row) => {
      if (
        row.managerId !== group.managerId ||
        (kind === 'triage'
          ? row.status !== 'pending_triage' ||
            !row.intakeId ||
            this.store.intake(row.intakeId)?.deliveryId !== group.groupId
          : row.status !== 'received' || row.reason !== 'awaiting_delivery')
      )
        return false
      const proof = this.store.routingEvidence(row)
      const evidence = proof?.event
      let reason: string | undefined
      if (!evidence || evidenceWithdrawn(this.store, row, evidence)) reason = 'evidence_withdrawn'
      else if (row.occurredAt + NOTIFY_TTL <= at) reason = 'notify_expired'
      else if (
        kind !== 'status' &&
        (isLocalBot(routing, row.actorId) ||
          (row.actorRoleAtCheck === 'owner'
            ? owner?.userId !== row.actorId
            : !row.actorRoleAtCheck ||
              ranks.indexOf(row.actorRoleAtCheck) < ranks.indexOf(source.minRole)))
      )
        reason = 'actor_scope_changed'
      else if (kind === 'triage' && proof) {
        const chosen = selectRoute(
          source,
          evidence,
          repo,
          (id) => this.store.manager.manager(id),
          routing,
          proof.addressedBotIds,
        )
        if (
          explicitTrigger(source, evidence, routing, proof.addressedBotIds) !== row.ruleId ||
          (!(
            'routeId' in chosen &&
            chosen.routeId === row.routeId &&
            chosen.managerId === group.managerId
          ) &&
            !(
              managerIdentity(routing, group.managerId) &&
              this.store.wasIntakeReassigned(row, group.managerId)
            ))
        )
          reason = 'rule_scope_changed'
      }
      if (!reason) return true
      if (update)
        this.store.updateInboxEvent(row.eventKey, row.revision, {
          ...(kind === 'triage' ? {} : { status: 'processed' }),
          reason,
        })
      return false
    })
    if (!active.length) return block('no_current_evidence')
    if (kind === 'status') {
      // 同一次合并/关闭只提示一次；同 run/attempt 只保留最近状态。
      const seen = new Set<string>()
      active = active
        .sort(
          (a, b) =>
            b.occurredAt - a.occurredAt ||
            Number(b.kind === 'merged') - Number(a.kind === 'merged') ||
            b.seq - a.seq,
        )
        .filter((row) => {
          const run = this.store.eventEvidence(row.eventKey)?.targetEvidence.run
          const key = run ? `ci:${run.runId}:${run.attempt}` : `terminal:${row.occurredAt}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    }
    return { group, events: active, category: kind }
  }

  async drain(managerId: string): Promise<boolean> {
    if (this.running.has(managerId)) return false
    const at = this.host.now()
    const manager = this.store.manager.manager(managerId)
    if (!manager || manager.status !== 'active') return false
    if (this.inFlight(managerId)) return false
    this.running.add(managerId)
    try {
      const plans = this.store.queue.deliveryGroups(managerId, 'queued').flatMap((group) => {
        if (group.availableAt > at) return []
        const plan = this.queued(group, at)
        return plan ? [plan] : []
      })
      const last = this.last.get(managerId)
      const rank = (plan: Plan) =>
        (last?.humanStreak ?? 0) >= 2
          ? plan.category === 'triage'
            ? 0
            : plan.category === 'human'
              ? 1
              : 2
          : plan.category === 'human'
            ? 0
            : 1
      plans.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(a.group.sourceId === last?.sourceId) -
            Number(b.group.sourceId === last?.sourceId) ||
          a.group.availableAt - b.group.availableAt,
      )
      for (const plan of plans) {
        if (!this.host.canDeliver(manager, plan.group.sourceId)) continue
        const decision = this.admit(plan, at, plans.length)
        if (decision.outcome === 'deferred') continue
        if (decision.outcome === 'rejected') {
          this.store.queue.finishDelivery(plan.group.groupId, 'blocked', at, {
            reason: decision.reason,
          })
          continue
        }
        return await this.submit(manager, plan.group, plans.length)
      }
      return false
    } finally {
      this.running.delete(managerId)
    }
  }

  private inFlight(managerId: string): boolean {
    return (
      this.store.queue.deliveryGroups(managerId, 'sending').length > 0 ||
      this.store.queue.deliveryGroups(managerId, 'unknown').length > 0
    )
  }

  private admit(plan: Plan, at: number, queuedGroups: number): ExternalAdmissionResult {
    const actorIds =
      plan.category === 'triage'
        ? [...new Set(plan.events.flatMap((event) => (event.actorId ? [event.actorId] : [])))]
        : []
    return this.admission({
      at,
      actorIds,
      sourceId: plan.group.sourceId,
      managerId: plan.group.managerId,
      subjectKey: plan.group.subjectKey,
      category: plan.category,
      queuedGroups,
      inFlight: this.inFlight(plan.group.managerId),
      sourceAttempts: this.store.deliveryBudgetTimes('source', plan.group.sourceId, at - WINDOW),
      actorAttempts: new Map(
        actorIds.map((id) => [id, this.store.deliveryBudgetTimes('actor', id, at - WINDOW)]),
      ),
    })
  }

  pressure(
    managerId: string,
    sourceId?: string,
  ): {
    pendingGroups: number
    limitedGroups: number
    oldestWaitingSeconds: number
    nextAdmissionAt: number | null
  } {
    const at = this.host.now()
    const groups = this.store.queue.deliveryGroups(managerId, 'queued')
    const scope = sourceId ? groups.filter((group) => group.sourceId === sourceId) : groups
    let limitedGroups = 0
    let oldest = at
    let next = Number.POSITIVE_INFINITY
    for (const group of scope) {
      for (const event of this.events(group)) oldest = Math.min(oldest, event.observedAt)
      const plan = this.queued(group, at, false)
      if (!plan) continue
      const decision = this.admit(plan, at, groups.length)
      if (decision.outcome === 'deferred') limitedGroups++
      if (decision.outcome !== 'rejected')
        next = Math.min(
          next,
          Math.max(at, group.availableAt, decision.outcome === 'deferred' ? decision.until : 0),
        )
    }
    return {
      pendingGroups: scope.length,
      limitedGroups,
      oldestWaitingSeconds: at - oldest,
      nextAdmissionAt: Number.isFinite(next) ? next : null,
    }
  }

  feedbackReason = (groupId: string, at: number): FeedbackWaitReason => {
    const group = this.store.queue.deliveryGroup(groupId)
    if (!group) return 'queued'
    const manager = this.store.manager.manager(group.managerId)
    if (manager) {
      const reason = this.host.feedbackWaitReason?.(manager, group.sourceId)
      if (reason) return reason
      if (!this.host.canDeliver(manager, group.sourceId)) return 'manager_busy'
    }
    const plan = this.queued(group, at, false)
    if (!plan) return 'queued'
    const admission = this.admit(
      plan,
      at,
      this.store.queue.deliveryGroups(group.managerId, 'queued').length,
    )
    if (admission.outcome === 'deferred')
      return admission.reason === 'manager_in_flight' ? 'manager_busy' : 'rate_limited'
    return 'queued'
  }

  /** 正常发送和重启后有证据的对账经过同一个确认入口。 */
  confirmDelivery(groupId: string, turnId: string, at: number): void {
    this.store.transaction(() => {
      if (this.store.queue.deliveryGroup(groupId)?.state === 'confirmed') return
      const group = this.store.queue.finishDelivery(groupId, 'confirmed', at, { turnId })
      if (group?.state === 'confirmed') this.host.feedback?.delivered(group)
    })
  }

  private async submit(
    manager: Manager,
    queued: ExternalDeliveryGroup,
    queuedGroups: number,
  ): Promise<boolean> {
    const { groupId, sourceId } = queued
    let submitted: Plan | undefined
    const currentPlan = (now: number, update: boolean) => {
      const current = this.store.manager.manager(manager.id)
      if (
        !current ||
        current.status !== 'active' ||
        current.threadId !== manager.threadId ||
        current.harness !== manager.harness ||
        !this.host.canDeliver(current, sourceId)
      )
        return null
      const group = this.store.queue.deliveryGroup(groupId)
      if (!group || group.state !== 'queued' || group.availableAt > now) return null
      const plan = this.queued(group, now, update)
      return plan && this.admit(plan, now, queuedGroups).outcome === 'allowed' ? plan : null
    }
    const eventId = `external-${groupId}`
    const result = await this.host
      .send({
        manager,
        sourceId,
        reason: EXTERNAL_WAKE_REASON,
        prepare: () => {
          const plan = currentPlan(this.host.now(), false)
          return plan ? { text: externalReminder(plan), eventId } : null
        },
        beforeSend: (expected) =>
          this.store.transaction(() => {
            const now = this.host.now()
            if (submitted) throw new Error('每次引擎请求只允许提交一次外部提醒')
            const plan = currentPlan(now, true)
            if (!plan) return null
            const text = externalReminder(plan)
            if (expected.text !== text || expected.eventId !== eventId) return null
            const staged = this.store.queue.stageDelivery(groupId, text, now, {
              threadId: manager.threadId,
              harness: manager.harness,
            })
            if (staged?.state !== 'sending' || !staged.deliveryId) return null
            this.host.feedback?.staged(staged, plan.category, plan.events)
            // 只对抵达引擎发送点的实际尝试记一次账，未知也视为可能已消耗。
            const ids: ['source' | 'actor', string][] = [['source', plan.group.sourceId]]
            if (plan.category === 'triage')
              for (const id of new Set(
                plan.events.flatMap((event) => (event.actorId ? [event.actorId] : [])),
              ))
                ids.push(['actor', id])
            for (const [scope, id] of ids)
              this.store.appendAudit({
                at: now,
                action: 'delivery_budget',
                subject: `delivery:${scope}:${id}`,
                operationId: groupId,
              })
            submitted = plan
            return { text, eventId, deliveryId: staged.deliveryId }
          }),
      })
      .catch((): ExternalSendResult => ({ outcome: 'unknown' }))
    if (!submitted) return false
    const plan: Plan = submitted
    const last = this.last.get(manager.id)
    this.last.set(manager.id, {
      sourceId: plan.group.sourceId,
      humanStreak: plan.category === 'human' ? (last?.humanStreak ?? 0) + 1 : 0,
    })
    const at = this.host.now()
    if (result.outcome === 'confirmed' && result.turnId) {
      this.confirmDelivery(groupId, result.turnId, at)
      return true
    }
    this.store.queue.finishDelivery(
      groupId,
      result.outcome === 'not_sent' ? 'blocked' : 'unknown',
      at,
      {
        reason: result.outcome === 'not_sent' ? 'engine_rejected' : 'submission_unknown',
      },
    )
    return false
  }
}

function externalReminder({ group, category, events }: Plan): string {
  return formatSessionEvent({
    kind: category === 'triage' ? 'manager-external-triage' : 'manager-external-bound',
    notes: [],
    manager: {
      managerId: group.managerId,
      text: JSON.stringify({
        sourceId: group.sourceId,
        groupId: group.groupId,
        ...(group.issueId ? { issueId: group.issueId } : {}),
        category,
        count: events.length,
      }),
    },
  })
}
