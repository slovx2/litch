import type { ExternalInboxEvent } from '../../../../protocol/src/external-sources.mjs'
import { isExternalEvent } from '../../../../protocol/src/external-validation.mjs'
import type { ExternalPollCheckpoint, ExternalStore } from '../../external-store.mjs'
import type { GithubPollEvent, GithubScope } from './poll-state.mjs'

const stream = 'github:evidence'
const pendingBucket = 'pending'
const seenBucket = 'seen'

export interface GithubPendingEvidence {
  event: GithubPollEvent
  observedAt: number
}

interface EvidenceIndex {
  sourceId: string
  pendingKey?: string
}

export type GithubEvidenceDisposition =
  | 'ignore'
  | {
      status: 'received' | 'blocked'
      reason?: string
    }

// C 线决定哪些证据应进收件箱。发现页先用同一事务持久保存证据，普通事件不占收件箱。
export class GithubEvidenceStore {
  private readonly store: ExternalStore
  constructor(store: ExternalStore) {
    this.store = store
  }

  stage(
    scope: GithubScope,
    events: readonly GithubPollEvent[],
    observedAt: number,
    priority = false,
  ): void {
    if (!events.length) return
    this.store.transaction(() => {
      const unique = new Set<string>()
      const fresh: ExternalPollCheckpoint[] = []
      const seen: ExternalPollCheckpoint[] = []
      for (const event of events) {
        const key = event.externalEventKey
        if (!isExternalEvent(event) || event.targetEvidence.subject.repoId !== scope.repoId) {
          throw new Error('GitHub 采集证据与仓库不符')
        }
        if (unique.has(key) || this.store.inboxEvent(key)) continue
        const indexed = this.index(scope, key)
        let firstObservedAt = observedAt
        if (indexed) {
          const pending = indexed.pendingKey
          if (
            !priority ||
            indexed.sourceId !== scope.sourceId ||
            !pending ||
            pending.startsWith('!')
          )
            continue
          firstObservedAt =
            this.store.pollCheckpoint<GithubPendingEvidence>(
              scope.sourceId,
              scope.repoId,
              stream,
              pendingBucket,
              pending,
            )?.observedAt ?? observedAt
          fresh.push({ bucket: pendingBucket, key: pending, value: null })
        }
        unique.add(key)
        const pendingKey = `${priority ? '!' : ''}${String(firstObservedAt).padStart(12, '0')}/${key}`
        seen.push({
          bucket: seenBucket,
          key,
          value: { sourceId: scope.sourceId, pendingKey } satisfies EvidenceIndex,
        })
        fresh.push({
          bucket: pendingBucket,
          key: pendingKey,
          value: { event, observedAt: firstObservedAt } satisfies GithubPendingEvidence,
        })
      }
      this.store.writePollCheckpoints({ ...scope, stream }, fresh)
      this.writeSeen(scope, seen)
    })
  }

  pending(
    scope: GithubScope,
    limit = 100,
    after?: string,
  ): { key: string; value: GithubPendingEvidence }[] {
    return this.store.pollCheckpointPage<GithubPendingEvidence>(
      { ...scope, stream },
      pendingBucket,
      limit,
      after,
    )
  }

  settle(
    scope: GithubScope,
    key: string,
    disposition: GithubEvidenceDisposition,
  ): ExternalInboxEvent | null {
    return this.store.transaction(() => {
      const indexed = this.index(scope, key)
      if (indexed && indexed.sourceId !== scope.sourceId) return null
      const pendingKey = indexed?.pendingKey
      if (!pendingKey) {
        const existing = this.store.inboxEvent(key)
        return existing?.sourceId === scope.sourceId && existing.subject.repoId === scope.repoId
          ? existing
          : null
      }
      const row = this.store.pollCheckpoint<GithubPendingEvidence>(
        scope.sourceId,
        scope.repoId,
        stream,
        pendingBucket,
        pendingKey,
      )
      if (!row) throw new Error('GitHub 待处理证据缺失')
      const { event, observedAt } = row
      const { subject, sourceEventId } = event.targetEvidence
      const result =
        disposition === 'ignore'
          ? null
          : this.store.insertInboxEvent({
              ...disposition,
              eventKey: key,
              sourceId: scope.sourceId,
              subjectKey: event.subjectKey,
              subject,
              sourceEventId,
              kind: event.kind,
              actorId: event.actorEvidence?.userId ?? null,
              actorRoleAtCheck: null,
              observedAt,
              occurredAt: event.occurredAt,
              eventUrl: event.permalink,
              contentVersion: event.contentVersion,
              evidence: event,
            }).record
      this.store.writePollCheckpoints({ ...scope, stream }, [
        { bucket: pendingBucket, key: pendingKey, value: null },
      ])
      this.writeSeen(scope, [{ bucket: seenBucket, key, value: { sourceId: scope.sourceId } }])
      return result
    })
  }

  // 空来源是设备级索引；实际待处理记录仍按收集该证据的来源隔离。
  private writeSeen(scope: GithubScope, rows: readonly ExternalPollCheckpoint[]): void {
    this.store.writePollCheckpoints({ sourceId: '', repoId: scope.repoId, stream }, rows)
  }

  private index(scope: GithubScope, key: string): EvidenceIndex | null {
    return this.store.pollCheckpoint<EvidenceIndex>('', scope.repoId, stream, seenBucket, key)
  }
}
