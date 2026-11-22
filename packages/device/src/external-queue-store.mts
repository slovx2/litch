// 提醒和回写共用经理库；入队、尝试、回执及相应绑定按事务提交。
import {
  type ExternalInboxEvent,
  type ExternalOutboxQuery,
  type ExternalOutboxSummary,
  type ExternalPage,
  type ExternalRef,
  externalSubjectKey,
} from '../../protocol/src/external-sources.mjs'
import type { ExternalConfigResult, ExternalStore, ExternalStored } from './external-store.mjs'
import {
  boundedLimit,
  decode,
  encode,
  numbered,
  page,
  requireExternalId,
  requireRow,
  where,
} from './external-store-internal.mjs'
import type {
  ExternalDeliveryGroup,
  ExternalOutboxRecord,
  ExternalWriteAttempt,
  ExternalWriteCompletion,
  NewExternalOutboxRecord,
} from './external-store-records.mjs'
import { managerNow } from './manager-store.mjs'

export class ExternalQueueStore {
  private readonly store: ExternalStore
  constructor(store: ExternalStore) {
    this.store = store
  }

  private get db() {
    return this.store.manager.db
  }

  deliveryGroup(groupId: string): ExternalDeliveryGroup | null {
    return decode(
      this.db.prepare('SELECT body FROM external_deliveries WHERE group_id=?').get(groupId),
    )
  }

  deliveryGroupForDelivery(deliveryId: string): ExternalDeliveryGroup | null {
    return decode(
      this.db.prepare('SELECT body FROM external_deliveries WHERE delivery_id=?').get(deliveryId),
    )
  }

  deliveryGroupForEvent(event: ExternalInboxEvent): ExternalDeliveryGroup | null {
    if (!event.managerId) return null
    if (event.intakeId) {
      const intake = this.store.intake(event.intakeId)
      const group = intake?.deliveryId && this.deliveryGroup(intake.deliveryId)
      return group &&
        group.managerId === event.managerId &&
        group.eventKeys.includes(event.eventKey)
        ? group
        : null
    }
    return decode(
      this.db
        .prepare(`SELECT d.body FROM external_deliveries d
      WHERE d.manager_id=? AND json_extract(d.body,'$.sourceId')=? AND EXISTS (
        SELECT 1 FROM json_each(d.body,'$.eventKeys') WHERE value=?
      ) ORDER BY d.rowid DESC LIMIT 1`)
        .get(event.managerId, event.sourceId, event.eventKey),
    )
  }

  deliveryGroups(
    managerId: string,
    state: ExternalDeliveryGroup['state'],
  ): ExternalDeliveryGroup[] {
    return this.db
      .prepare(
        'SELECT body FROM external_deliveries WHERE manager_id=? AND state=? ORDER BY available_at,rowid',
      )
      .all(managerId, state)
      .map((row) => decode<ExternalDeliveryGroup>(row))
  }

  hasPendingDelivery(managerId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM external_deliveries WHERE manager_id=? AND state IN ('queued','sending','unknown') LIMIT 1",
      )
      .get(managerId)
  }

  queueDeliveryGroup(
    group: Omit<ExternalDeliveryGroup, 'state' | 'deliveryId' | 'turnId'>,
  ): ExternalDeliveryGroup {
    return this.store.transaction(() => {
      const before = this.deliveryGroup(group.groupId)
      if (
        before &&
        (before.managerId !== group.managerId ||
          before.subjectKey !== group.subjectKey ||
          before.sourceId !== group.sourceId ||
          before.issueId !== group.issueId)
      )
        throw new Error('投递组已有不同归属')
      if (before && before.state !== 'queued') return before
      const record: ExternalDeliveryGroup = {
        ...group,
        eventKeys: [...new Set([...(before?.eventKeys ?? []), ...group.eventKeys])],
        state: 'queued',
      }
      this.writeDeliveryGroup(record)
      return record
    })
  }

  /** 入旧队列与记录发送意图同时提交，重启后用同一 deliveryId 核对。 */
  stageDelivery(
    groupId: string,
    text: string,
    at: number,
    target?: ExternalDeliveryGroup['target'],
  ): ExternalDeliveryGroup | null {
    return this.store.transaction(() => {
      const before = this.deliveryGroup(groupId)
      if (before?.state !== 'queued' || before.availableAt > at) return before
      const record: ExternalDeliveryGroup = {
        ...before,
        deliveryId: this.store.manager.enqueue(before.managerId, text),
        ...(target ? { target } : {}),
        state: 'sending',
      }
      this.writeDeliveryGroup(record)
      this.store.appendAudit({
        at,
        subject: before.subjectKey,
        action: 'delivery_staged',
        managerId: before.managerId,
        eventKeys: before.eventKeys,
      })
      return record
    })
  }

  finishDelivery(
    groupId: string,
    state: 'confirmed' | 'unknown' | 'blocked',
    at: number,
    detail: { turnId?: string; reason?: string } = {},
  ): ExternalDeliveryGroup | null {
    return this.store.transaction(() => {
      const before = this.deliveryGroup(groupId)
      if (
        !before ||
        before.state === 'confirmed' ||
        before.state === 'blocked' ||
        (before.state === 'queued' && state !== 'blocked')
      )
        return before
      if (state === 'confirmed' && !detail.turnId) throw new Error('投递确认必须提供回合 ID')
      const record: ExternalDeliveryGroup = { ...before, ...detail, state }
      this.writeDeliveryGroup(record)
      if (before.deliveryId && state !== 'unknown') this.store.manager.delivered(before.deliveryId)
      if (state === 'confirmed' && before.issueId) {
        for (const key of before.eventKeys) {
          const event = this.store.inboxEvent(key)
          if (
            event?.status === 'received' &&
            event.managerId === before.managerId &&
            event.issueId === before.issueId
          )
            this.store.updateInboxEvent(key, event.revision, { status: 'notified' })
        }
      }
      this.store.appendAudit({
        at,
        subject: before.subjectKey,
        action: 'delivery_finished',
        state,
        managerId: before.managerId,
        eventKeys: before.eventKeys,
        ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
      })
      return record
    })
  }

  private writeDeliveryGroup(group: ExternalDeliveryGroup): void {
    this.db
      .prepare(
        'INSERT INTO external_deliveries VALUES(?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET delivery_id=excluded.delivery_id,state=excluded.state,available_at=excluded.available_at,body=excluded.body',
      )
      .run(
        group.groupId,
        group.deliveryId ?? null,
        group.managerId,
        group.state,
        group.availableAt,
        encode(group),
      )
  }

  outboxRecord(operationId: string): ExternalOutboxRecord | null {
    return numbered(
      this.db.prepare('SELECT seq,body FROM external_outbox WHERE operation_id=?').get(operationId),
    )
  }

  outboxByIdempotencyKey(key: string): ExternalOutboxRecord | null {
    return numbered(
      this.db.prepare('SELECT seq,body FROM external_outbox WHERE idem_key=?').get(key),
    )
  }

  enqueueOutbox(entry: NewExternalOutboxRecord): ExternalStored<ExternalOutboxRecord> {
    return this.store.transaction(() => {
      const existing =
        this.outboxByIdempotencyKey(entry.idempotencyKey) ?? this.outboxRecord(entry.operationId)
      if (existing) return { inserted: false, record: existing }
      this.store.checkSubject(entry.targetRef)
      const value = { ...entry, revision: 1, state: 'queued' as const, attempts: 0 }
      const row = this.db
        .prepare(
          'INSERT INTO external_outbox(operation_id,idem_key,source_id,manager_id,repo_id,subject_key,state,next_attempt,body) VALUES(?,?,?,?,?,?,?,?,?) RETURNING seq',
        )
        .get(
          value.operationId,
          value.idempotencyKey,
          value.sourceId,
          value.managerId,
          value.targetRef.repoId,
          externalSubjectKey(value.targetRef),
          value.state,
          value.nextAttempt ?? null,
          encode(value),
        )
      const record = { ...value, seq: Number(requireRow(row).seq) }
      this.auditOutbox(record, 'outbox_queued', managerNow())
      return { inserted: true, record }
    })
  }

  outbox(query: ExternalOutboxQuery = {}): ExternalPage<ExternalOutboxSummary> {
    const { sql, bindings } = where([
      ['seq<?', query.beforeSeq],
      ['source_id=?', query.sourceId],
      ['manager_id=?', query.managerId],
      ['repo_id=?', query.repoId],
      ["json_extract(body,'$.issueId')=?", query.issueId],
      ['state=?', query.state],
    ])
    const limit = boundedLimit(query.limit)
    const entries = this.db
      .prepare(`SELECT seq,body FROM external_outbox ${sql} ORDER BY seq DESC LIMIT ?`)
      .all(...bindings, limit + 1)
      .map((row) => externalOutboxSummary(numbered<ExternalOutboxRecord>(row)))
    return page(entries, limit)
  }

  outboxChanges(): { sourceId: string; managerId: string; pending: number; revision: number }[] {
    return this.db
      .prepare(`SELECT source_id, manager_id, sum(json_extract(body,'$.revision')) AS revision,
      sum(CASE WHEN state IN ('queued', 'sending', 'unknown') THEN 1 ELSE 0 END) AS pending
      FROM external_outbox GROUP BY source_id, manager_id`)
      .all()
      .map((row) => ({
        sourceId: String(row.source_id),
        managerId: String(row.manager_id),
        pending: Number(row.pending),
        revision: Number(row.revision),
      }))
  }

  readyOutbox(at: number, limit = 50): ExternalOutboxRecord[] {
    return this.db
      .prepare(
        "SELECT seq,body FROM external_outbox WHERE state='queued' AND (next_attempt IS NULL OR next_attempt<=?) ORDER BY seq LIMIT ?",
      )
      .all(at, boundedLimit(limit))
      .map((row) => numbered<ExternalOutboxRecord>(row))
  }

  writeAttempts(operationId: string): ExternalWriteAttempt[] {
    return this.db
      .prepare('SELECT body FROM external_write_attempts WHERE operation_id=? ORDER BY attempt')
      .all(operationId)
      .map((row) => decode<ExternalWriteAttempt>(row))
  }

  /** D 线完成授权复核后调用；拿到 applied 才可发起外部写入。 */
  beginWrite(
    operationId: string,
    expectedRevision: number,
    at: number,
    leaseUntil: number,
  ): ExternalConfigResult<ExternalOutboxRecord> {
    return this.store.transaction(() => {
      const before = this.outboxRecord(operationId)
      if (
        !before ||
        before.revision !== expectedRevision ||
        before.state !== 'queued' ||
        (before.nextAttempt ?? 0) > at ||
        leaseUntil <= at ||
        this.db
          .prepare("SELECT 1 FROM external_outbox WHERE subject_key=? AND state='sending'")
          .get(externalSubjectKey(before.targetRef))
      )
        return { outcome: 'conflict', record: before }
      const record: ExternalOutboxRecord = {
        ...before,
        leaseUntil,
        revision: expectedRevision + 1,
        state: 'sending',
        attempts: before.attempts + 1,
      }
      const attempt: ExternalWriteAttempt = { operationId, attempt: record.attempts, startedAt: at }
      this.writeOutbox(record)
      this.db
        .prepare('INSERT INTO external_write_attempts VALUES(?,?,?)')
        .run(operationId, attempt.attempt, encode(attempt))
      this.auditOutbox(record, 'write_started', at)
      return { outcome: 'applied', record }
    })
  }

  finishWrite(
    operationId: string,
    attempt: number,
    completion: ExternalWriteCompletion,
    prRef?: ExternalRef,
  ): ExternalConfigResult<ExternalOutboxRecord> {
    return this.store.transaction(() => {
      const before = this.outboxRecord(operationId)
      if (
        !before ||
        !['sending', 'unknown'].includes(before.state) ||
        before.attempts !== attempt ||
        (before.state === 'unknown' && completion.outcome !== 'confirmed')
      )
        return { outcome: 'conflict', record: before }
      const started = decode<ExternalWriteAttempt>(
        this.db
          .prepare('SELECT body FROM external_write_attempts WHERE operation_id=? AND attempt=?')
          .get(operationId, attempt),
      )
      if (!started) throw new Error('缺少已持久化的写入尝试')
      const { at, errorClass, outcome, nextAttempt, receipt, requestId } = completion
      if (outcome === 'confirmed') {
        if (!receipt) throw new Error('确认外部写入须有回执')
        if (before.state === 'unknown' && receipt.verifiedBy === 'response')
          throw new Error('结果未知的操作须先对账')
        requireExternalId(receipt.objectId)
        requireExternalId(receipt.botUserId)
        if (before.action === 'draft_pr') {
          if (
            !prRef ||
            !before.issueId ||
            prRef.managerId !== before.managerId ||
            prRef.issueId !== before.issueId ||
            prRef.provider !== before.targetRef.provider ||
            prRef.repoId !== before.targetRef.repoId ||
            prRef.kind !== 'pull_request' ||
            prRef.origin !== 'write_receipt' ||
            prRef.url !== receipt.url
          )
            throw new Error('草稿 PR 回执须提交同仓库的议题绑定')
          const existing = this.store.bindRef(prRef).record
          if (existing.managerId !== prRef.managerId || existing.issueId !== prRef.issueId) {
            if (before.state === 'unknown') return { outcome: 'conflict', record: before }
            const recorded = this.finishWrite(operationId, attempt, {
              outcome: 'unknown',
              at,
              errorClass: 'binding_conflict',
            })
            return { outcome: 'conflict', record: recorded.record }
          }
        } else if (prRef) throw new Error('此回写动作不创建 PR 绑定')
      } else if (prRef || receipt) throw new Error('只有已确认的写入记录回执和绑定')
      const record = { ...before }
      delete record.leaseUntil
      delete record.nextAttempt
      delete record.errorClass
      record.state = outcome === 'retryable' ? 'queued' : outcome
      record.revision += 1
      if (outcome === 'retryable') {
        if (nextAttempt === undefined || nextAttempt <= at)
          throw new Error('重试必须指定未来的时间')
        record.nextAttempt = nextAttempt
      }
      if (receipt) record.receipt = receipt
      if (errorClass) record.errorClass = errorClass
      this.writeOutbox(record)
      if (outcome === 'confirmed') this.store.resultReplies.confirmed(record)
      // 保留初次试发的未知结局；之后查证的结果另入审计和操作回执。
      if (before.state === 'sending') {
        const finished: ExternalWriteAttempt = {
          ...started,
          finishedAt: at,
          outcome,
          ...(requestId ? { requestId } : {}),
          ...(errorClass ? { errorClass } : {}),
        }
        this.db
          .prepare('UPDATE external_write_attempts SET body=? WHERE operation_id=? AND attempt=?')
          .run(encode(finished), operationId, attempt)
      }
      this.auditOutbox(
        record,
        before.state === 'unknown' ? 'write_reconciled' : 'write_finished',
        at,
      )
      return { outcome: 'applied', record }
    })
  }

  expireWriteLeases(at: number): ExternalOutboxRecord[] {
    return this.store.transaction(() =>
      this.db
        .prepare(
          "SELECT seq,body FROM external_outbox WHERE state='sending' AND json_extract(body,'$.leaseUntil')<=?",
        )
        .all(at)
        .map((row) => {
          const record = numbered<ExternalOutboxRecord>(row)
          return requireRow(
            this.finishWrite(record.operationId, record.attempts, {
              outcome: 'unknown',
              errorClass: 'lease_expired',
              at,
            }).record,
          )
        }),
    )
  }

  cancelOutbox(
    operationId: string,
    expectedRevision: number,
    actorId: string,
    at: number,
  ): ExternalConfigResult<ExternalOutboxRecord> {
    return this.store.transaction(() => {
      const before = this.outboxRecord(operationId)
      if (before?.state === 'canceled' && before.revision === expectedRevision + 1)
        return { outcome: 'applied', record: before }
      if (!before || before.revision !== expectedRevision || before.state !== 'queued')
        return { outcome: 'conflict', record: before }
      const record = { ...before, state: 'canceled' as const, revision: before.revision + 1 }
      delete record.nextAttempt
      this.writeOutbox(record)
      this.auditOutbox(record, 'outbox_canceled', at, actorId)
      return { outcome: 'applied', record }
    })
  }

  private writeOutbox(record: ExternalOutboxRecord): void {
    this.db
      .prepare('UPDATE external_outbox SET state=?,next_attempt=?,body=? WHERE operation_id=?')
      .run(record.state, record.nextAttempt ?? null, encode(record), record.operationId)
  }

  private auditOutbox(
    record: ExternalOutboxRecord,
    action: string,
    at: number,
    actorId?: string,
  ): void {
    this.store.appendAudit({
      at,
      subject: externalSubjectKey(record.targetRef),
      action,
      state: record.state,
      operationId: record.operationId,
      managerId: record.managerId,
      policyRevision: record.policyRevision,
      ...(record.issueId ? { issueId: record.issueId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(record.errorClass ? { reason: record.errorClass } : {}),
    })
  }
}

export function externalOutboxSummary(record: ExternalOutboxRecord): ExternalOutboxSummary {
  const {
    seq,
    operationId,
    sourceId,
    managerId,
    issueId,
    targetRef,
    action,
    state,
    revision,
    attempts,
    nextAttempt,
    receipt,
    errorClass,
  } = record
  return {
    seq,
    operationId,
    sourceId,
    managerId,
    targetRef: {
      provider: targetRef.provider,
      repoId: targetRef.repoId,
      number: targetRef.number,
      kind: targetRef.kind,
      url: targetRef.url,
    },
    action,
    state,
    revision,
    attempts,
    ...(issueId !== undefined ? { issueId } : {}),
    ...(nextAttempt !== undefined ? { nextAttempt } : {}),
    ...(receipt !== undefined
      ? {
          receipt: {
            objectId: receipt.objectId,
            url: receipt.url,
            at: receipt.at,
            botUserId: receipt.botUserId,
            verifiedBy: receipt.verifiedBy,
            ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }),
          },
        }
      : {}),
    ...(errorClass !== undefined ? { errorClass } : {}),
  }
}
