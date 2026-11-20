// 程序反馈和收件箱/实际投递同事务入账；D 只消费固定动作，不接受模型填写这些字段。
import type {
  ExternalInboxEvent,
  ExternalSubject,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalDeliveryGroup, ExternalStore } from '../external-store.mjs'
import type { ReminderCategory } from './intake.mjs'
import { type ExternalRoutingPolicy, managerIdentity, repositoryRouting } from './routing.mjs'

export type FeedbackWaitReason = 'queued' | 'manager_busy' | 'paused' | 'rate_limited'
type FeedbackComment = { kind: 'comment' | 'review_comment'; id: string }
type Scope = { sourceId: string; repoId: string }
type FeedbackTarget = {
  sourceId: string
  managerId: string
  identityId: string
  botUserId: string
  subject: ExternalSubject
}
type FeedbackAction =
  | { action: 'ack_comment_create'; text: string }
  | { action: 'ack_comment_update'; createKey: string; text: string }
  | { action: 'reaction_add'; comment: FeedbackComment; reaction: 'eyes' | 'rocket' }
export type ExternalFeedbackIntent = FeedbackTarget & FeedbackAction & { idempotencyKey: string }
type Ack = Extract<ExternalFeedbackIntent, { action: 'ack_comment_create' }>
type StagedFeedback = { intakeIds: string[]; boundEventKeys: string[] }

export interface ExternalFeedbackHost {
  configuration: ExternalRoutingPolicy
  language?(): 'zh-CN' | 'en'
  /** D 验证身份、仓库与写权限后，按稳定键持久入 outbox；暂不可用时返回 retry。 */
  enqueue(intent: ExternalFeedbackIntent): Promise<'queued' | 'skipped' | 'retry'>
}

const stream = 'github:feedback'
const ackKey = (id: string) => `ack:create:${id}`

function copy(language: 'zh-CN' | 'en', reason: FeedbackWaitReason): string {
  const queue = {
    queued: '',
    manager_busy: ' (I’m finishing something else.)',
    paused: ' (Paused.)',
    rate_limited: ' (Delivery is rate limited.)',
  }
  const zh = {
    queued: '',
    manager_busy: '（手头还有别的事）',
    paused: '（已暂停）',
    rate_limited: '（已达限额）',
  }
  return language === 'zh-CN'
    ? `收到，排队中，稍后就看${zh[reason]}`
    : `Got it — queued, I'll take a look shortly.${queue[reason]}`
}

const reactionKey = (event: ExternalInboxEvent, reaction: 'eyes' | 'rocket') =>
  `reaction:${event.subject.provider}:${event.subject.repoId}:${event.kind}:${event.sourceEventId}:${reaction}`

export class ExternalFeedback {
  private readonly store: ExternalStore
  private readonly host: ExternalFeedbackHost
  private readonly flushing = new Set<string>()
  constructor(store: ExternalStore, host: ExternalFeedbackHost) {
    this.store = store
    this.host = host
  }

  private identity(scope: Scope, managerId: string) {
    const snapshot = this.host.configuration()
    const repo = snapshot.repositories.find((item) => item.repoId === scope.repoId)
    if (!repo || repo.immediateFeedback === false) return null
    const identity = managerIdentity(repositoryRouting(snapshot, scope.repoId), managerId)
    return identity ?? null
  }

  private target(event: ExternalInboxEvent): FeedbackTarget | null {
    const { sourceId, managerId, subject } = event
    const identity = managerId
      ? this.identity({ sourceId, repoId: subject.repoId }, managerId)
      : null
    return managerId && identity
      ? {
          sourceId,
          managerId,
          subject,
          identityId: identity.identityId,
          botUserId: identity.botUserId,
        }
      : null
  }

  private save(intent: ExternalFeedbackIntent): void {
    const scope = { sourceId: intent.sourceId, repoId: intent.subject.repoId, stream }
    this.store.transaction(() => {
      if (
        this.store.pollCheckpoint(
          scope.sourceId,
          scope.repoId,
          stream,
          'issued',
          intent.idempotencyKey,
        )
      )
        return
      this.store.writePollCheckpoints(scope, [
        { bucket: 'issued', key: intent.idempotencyKey, value: intent },
        { bucket: 'pending', key: intent.idempotencyKey, value: intent },
      ])
    })
  }

  private reaction(
    event: ExternalInboxEvent,
    target: FeedbackTarget,
    reaction: 'eyes' | 'rocket',
  ): void {
    if (event.kind !== 'comment' && event.kind !== 'review_comment') return
    this.save({
      ...target,
      action: 'reaction_add',
      comment: { kind: event.kind, id: event.sourceEventId },
      reaction,
      idempotencyKey: reactionKey(event, reaction),
    })
  }

  /** 调用者已核验路由、权限和时效，并且正处于收件箱事务内。 */
  received(
    event: ExternalInboxEvent,
    category: ReminderCategory,
    reason: FeedbackWaitReason,
    createAck = true,
  ): void {
    if (category === 'status' || (category === 'triage' && !event.intakeId)) return
    const target = this.target(event)
    if (!target) return
    if (category === 'human') {
      this.reaction(event, target, 'eyes')
      return
    }
    if (!event.intakeId) return
    if (createAck)
      this.save({
        ...target,
        action: 'ack_comment_create',
        idempotencyKey: ackKey(event.intakeId),
        text: copy(this.host.language?.() ?? 'zh-CN', reason),
      })
    if (event.ruleId === 'mention') this.reaction(event, target, 'eyes')
  }

  /** 在发送点记实际交给引擎的事件子集，未知投递对账后也只反馈这些事件。 */
  staged(
    group: ExternalDeliveryGroup,
    category: ReminderCategory,
    events: readonly ExternalInboxEvent[],
  ): void {
    const subject = events[0]?.subject
    if (!subject || category === 'status') return
    const value: StagedFeedback = {
      intakeIds:
        category === 'triage'
          ? [...new Set(events.flatMap((row) => (row.intakeId ? [row.intakeId] : [])))]
          : [],
      boundEventKeys: category === 'human' ? events.map((row) => row.eventKey) : [],
    }
    this.store.writePollCheckpoints({ sourceId: group.sourceId, repoId: subject.repoId, stream }, [
      { bucket: 'delivery', key: group.groupId, value },
    ])
  }

  /** 调用者须已确认真实回合；重复确认不会再产生反馈。 */
  delivered(group: ExternalDeliveryGroup): void {
    const subject = group.eventKeys.flatMap((key) => {
      const row = this.store.inboxEvent(key)
      return row ? [row.subject] : []
    })[0]
    if (!subject || group.state !== 'confirmed' || !group.turnId) return
    const { sourceId, managerId } = group
    const { repoId } = subject
    const plan = this.store.pollCheckpoint<StagedFeedback>(
      sourceId,
      repoId,
      stream,
      'delivery',
      group.groupId,
    )
    const identity = this.identity({ sourceId, repoId }, managerId)
    if (!plan || !identity) return
    for (const id of plan.intakeIds) {
      const createKey = ackKey(id)
      const create = this.store.pollCheckpoint<Ack>(sourceId, repoId, stream, 'issued', createKey)
      if (
        !create ||
        create.botUserId !== identity.botUserId ||
        create.identityId !== identity.identityId
      )
        continue
      this.save({
        ...create,
        action: 'ack_comment_update',
        idempotencyKey: `ack:update:${id}`,
        createKey,
        text: this.host.language?.() === 'en' ? "Got it, I'm on it." : '收到，我在看了',
      })
    }
    for (const key of plan.boundEventKeys) {
      const event = this.store.inboxEvent(key)
      const target = event && this.target(event)
      const eyes =
        event &&
        this.store.pollCheckpoint<ExternalFeedbackIntent>(
          sourceId,
          repoId,
          stream,
          'issued',
          reactionKey(event, 'eyes'),
        )
      if (
        event &&
        target?.managerId === managerId &&
        eyes?.identityId === target.identityId &&
        eyes.botUserId === target.botUserId
      )
        this.reaction(event, target, 'rocket')
    }
  }

  /** 进程退出或 D 暂停后可重取；D 对同一个键重复接收时返回同一操作。 */
  async flush(scope: Scope): Promise<void> {
    const flight = JSON.stringify(scope)
    if (this.flushing.has(flight)) return
    this.flushing.add(flight)
    try {
      for (const row of this.store.pollCheckpointPage<ExternalFeedbackIntent>(
        { ...scope, stream },
        'pending',
        100,
      )) {
        const intent = row.value
        const source = this.store.config.source(scope.sourceId)
        if (source && !source.enabled) return
        const identity = this.identity(scope, intent.managerId)
        if (
          source?.repos.some((repo) => repo.repoId === scope.repoId) &&
          identity?.identityId === intent.identityId &&
          identity.botUserId === intent.botUserId
        ) {
          const result = await this.host.enqueue(intent).catch(() => 'retry')
          if (result === 'retry') continue
        }
        this.store.writePollCheckpoints({ ...scope, stream }, [
          { bucket: 'pending', key: row.key, value: null },
        ])
      }
    } finally {
      this.flushing.delete(flight)
    }
  }
}
