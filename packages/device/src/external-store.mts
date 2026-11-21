// GitHub 等外部来源的设备账本，与 X-n 和模型投递共用经理库。
import { randomUUID } from 'node:crypto'
import {
  type ExternalCredential,
  type ExternalEvent,
  type ExternalInboxEvent,
  type ExternalInboxQuery,
  type ExternalIntake,
  type ExternalIssueFields,
  type ExternalIssueId,
  type ExternalMandate,
  type ExternalPage,
  type ExternalRef,
  type ExternalSubject,
  type ExternalTriageResult,
  externalSubjectKey,
} from '../../protocol/src/external-sources.mjs'
import { isExternalEvent } from '../../protocol/src/external-validation.mjs'
import type { ManagerIssue } from '../../protocol/src/manager-issues.mjs'
import { ExternalConfigStore } from './external-config-store.mjs'
import { ExternalQueueStore } from './external-queue-store.mjs'
import {
  boundedLimit,
  decode,
  encode,
  numbered,
  page,
  requireExternalId,
  requireRow,
  signature,
  where,
} from './external-store-internal.mjs'
import type {
  ExternalAuditEntry,
  ExternalCursor,
  ExternalObservation,
  ExternalOutboxRecord,
  ExternalPollCheckpoint,
  ExternalPollPage,
  ExternalRunWatch,
  ExternalSubjectObservation,
  ExternalTriageCommit,
  ExternalTriageHooks,
  NewExternalInboxEvent,
} from './external-store-records.mjs'
import { type ManagerStore, managerNow } from './manager-store.mjs'

export { externalOutboxSummary } from './external-queue-store.mjs'
export type * from './external-store-records.mjs'
export type ExternalStored<T> = { inserted: boolean; record: T }
export type ExternalConfigResult<T> =
  | { outcome: 'applied'; record: T }
  | { outcome: 'conflict'; record: T | null }

export class ExternalStore {
  readonly manager: ManagerStore
  readonly queue: ExternalQueueStore
  readonly config: ExternalConfigStore
  constructor(manager: ManagerStore) {
    this.manager = manager
    this.queue = new ExternalQueueStore(this)
    this.config = new ExternalConfigStore(this)
  }

  private get db() {
    return this.manager.db
  }

  /** 只在设备已校验调用者及平台证据后调用。嵌套调用复用外层经理库事务。 */
  transaction<T>(work: () => T): T {
    return this.db.isTransaction ? work() : this.manager.transaction(work)
  }

  /** 凭据重放只取公有回执，无需重新探测或覆盖已落盘的秘密。 */
  credentialRequest(credentialRef: string, operationId: string): ExternalCredential | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_config_requests WHERE scope=? AND operation_id=?')
        .get(`credential:${credentialRef}`, operationId),
    )
  }

  /** 保存公开凭据类型；与 A 的凭据元数据和幂等回执在同一事务。 */
  setExternalCredentialGrant(
    credentialRef: string,
    operationId: string,
    credentialKind: 'oauth' | 'fine_grained',
    scopes?: string[],
  ): void {
    const grant = encode({ credentialKind, ...(scopes ? { scopes } : {}) })
    this.db
      .prepare('UPDATE external_credentials SET body=json_patch(body,?) WHERE credential_ref=?')
      .run(grant, credentialRef)
    this.db
      .prepare(
        'UPDATE external_config_requests SET body=json_patch(body,?) WHERE scope=? AND operation_id=?',
      )
      .run(grant, `credential:${credentialRef}`, operationId)
  }

  /** GitHub 身份以机器人数字 ID 归组；各资源所有者的凭据代次彼此独立。 */
  externalCredentials(): ExternalCredential[] {
    return this.db
      .prepare('SELECT body FROM external_credentials ORDER BY credential_ref')
      .all()
      .map((row) => decode<ExternalCredential>(row))
  }

  externalIdentityProfile(identityId: string): { login: string; revision: number } | null {
    return decode(
      this.db
        .prepare(
          "SELECT body FROM external_config_requests WHERE scope=? ORDER BY json_extract(body,'$.revision') DESC LIMIT 1",
        )
        .get(`identity:${identityId}`),
    )
  }

  recordExternalIdentityChange(identityId: string, verifiedLogin?: string): void {
    this.transaction(() => {
      const before = this.externalIdentityProfile(identityId)
      const login = verifiedLogin ?? before?.login
      if (!login) return
      const revision = (before?.revision ?? 0) + 1
      this.db
        .prepare('INSERT INTO external_config_requests VALUES(?,?,?)')
        .run(`identity:${identityId}`, String(revision), encode({ login, revision }))
    })
  }

  githubFeedbackPermissionFailure(scope: string): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(json_extract(body,'$.at')) AS at FROM external_config_requests WHERE scope=?",
      )
      .get(`feedback-write:${scope}`)
    return typeof row?.at === 'number' ? row.at : null
  }

  noteGithubFeedbackPermissionFailure(scope: string, at: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO external_config_requests VALUES(?,?,?)')
      .run(`feedback-write:${scope}`, String(at), encode({ at }))
  }

  /** 外部反馈编辑等待原评论回执；等待不占用尝试与发送租约。 */
  deferQueuedExternalWrite(
    operationId: string,
    expectedRevision: number,
    nextAttempt: number,
  ): void {
    this.transaction(() => {
      const before = this.queue.outboxRecord(operationId)
      if (before?.state !== 'queued' || before.revision !== expectedRevision) return
      this.db
        .prepare('UPDATE external_outbox SET next_attempt=?,body=? WHERE operation_id=?')
        .run(
          nextAttempt,
          encode({ ...before, nextAttempt, revision: expectedRevision + 1 }),
          operationId,
        )
    })
  }

  /** 平台明确拒绝该代时断用；保留原作用域，供同机器人轮换。 */
  invalidateExternalCredential(
    credentialRef: string,
    generation: number,
    at: number,
    reason: string,
  ): void {
    this.transaction(() => {
      const before = this.config.credential(credentialRef)
      if (before?.state !== 'active' || before.generation !== generation) return
      this.db
        .prepare('UPDATE external_credentials SET body=? WHERE credential_ref=?')
        .run(encode({ ...before, state: 'invalid' }), credentialRef)
      this.recordExternalIdentityChange(before.botUserId)
      this.config.bump()
      this.appendAudit({
        at,
        subject: `credential:${credentialRef}`,
        action: 'credential_invalidated',
        state: 'invalid',
        reason,
      })
    })
  }

  /** 对账窗口以首次未知时间为准；暂停不会把操作重新排进发送队列。 */
  unknownWritesDue(at: number, limit: number): ExternalOutboxRecord[] {
    return this.db
      .prepare(
        `SELECT o.seq,o.body FROM external_outbox o
       WHERE o.state='unknown' AND (o.next_attempt IS NULL OR o.next_attempt<=?)
       AND COALESCE(json_extract(o.body,'$.errorClass'),'')<>'external_write_manual_confirmation_required'
       ORDER BY COALESCE(o.next_attempt,0),o.seq LIMIT ?`,
      )
      .all(at, boundedLimit(limit))
      .map((row) => numbered<ExternalOutboxRecord>(row))
  }

  deferUnknownWrite(
    operationId: string,
    revision: number,
    at: number,
    nextAttempt: number | null,
    reason: string,
  ): void {
    this.transaction(() => {
      const before = this.queue.outboxRecord(operationId)
      if (before?.state !== 'unknown' || before.revision !== revision) return
      const record = { ...before, revision: revision + 1, errorClass: reason }
      if (nextAttempt === null) delete record.nextAttempt
      else record.nextAttempt = nextAttempt
      this.db
        .prepare('UPDATE external_outbox SET next_attempt=?,body=? WHERE operation_id=?')
        .run(nextAttempt, encode(record), operationId)
      this.appendAudit({
        at,
        action: 'write_recheck_deferred',
        state: 'unknown',
        reason,
        subject: externalSubjectKey(record.targetRef),
        operationId,
        managerId: record.managerId,
        policyRevision: record.policyRevision,
        ...(record.issueId ? { issueId: record.issueId } : {}),
      })
    })
  }

  externalWritesForRepo(
    sourceId: string,
    repoId: string,
    action: ExternalOutboxRecord['action'],
    states: readonly ExternalOutboxRecord['state'][],
  ): ExternalOutboxRecord[] {
    if (!states.length) return []
    return this.db
      .prepare(
        `SELECT seq,body FROM external_outbox WHERE source_id=? AND repo_id=?
       AND json_extract(body,'$.action')=? AND state IN (${states.map(() => '?').join(',')})
       ORDER BY seq DESC`,
      )
      .all(sourceId, repoId, action, ...states)
      .map((row) => numbered<ExternalOutboxRecord>(row))
  }

  cursor(sourceId: string, repoId: string, stream: string): ExternalCursor | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_cursor WHERE source_id=? AND repo_id=? AND stream=?')
        .get(sourceId, repoId, stream),
    )
  }

  cursors(sourceId: string): ExternalCursor[] {
    return this.db
      .prepare('SELECT body FROM external_cursor WHERE source_id=? ORDER BY repo_id,stream')
      .all(sourceId)
      .map((row) => decode<ExternalCursor>(row))
  }

  observation(
    sourceId: string,
    repoId: string,
    stream: string,
    objectKey: string,
  ): ExternalObservation | null {
    return decode(
      this.db
        .prepare(
          'SELECT body FROM external_observed WHERE source_id=? AND repo_id=? AND stream=? AND object_key=?',
        )
        .get(sourceId, repoId, stream, objectKey),
    )
  }

  latestObservation(
    sourceId: string,
    repoId: string,
    objectKey: string,
  ): ExternalObservation | null {
    return decode(
      this.db
        .prepare(
          "SELECT body FROM external_observed WHERE source_id=? AND repo_id=? AND object_key=? ORDER BY json_extract(body,'$.updatedAt') DESC,json_extract(body,'$.observedAt') DESC,rowid DESC LIMIT 1",
        )
        .get(sourceId, repoId, objectKey),
    )
  }

  observations(sourceId: string, subjectKey: string): ExternalObservation[] {
    return this.db
      .prepare(
        'SELECT body FROM external_observed WHERE source_id=? AND subject_key=? ORDER BY rowid',
      )
      .all(sourceId, subjectKey)
      .map((row) => decode<ExternalObservation>(row))
  }

  /** B 线先证明覆盖，再提交一页；传入进行中的窗口不会自行推高完整水位。 */
  commitPollPage(page: ExternalPollPage): ExternalStored<ExternalInboxEvent>[] {
    return this.transaction(() => {
      const { cursor, observations, events = [], checkpoints = [] } = page
      const { sourceId, repoId, stream } = cursor
      requireExternalId(repoId)
      const previous = this.cursor(sourceId, repoId, stream)
      if (
        previous?.coveredThrough != null &&
        (cursor.coveredThrough == null || cursor.coveredThrough < previous.coveredThrough)
      )
        throw new Error('完整水位不能回退')
      for (const observed of observations) {
        requireExternalId(observed.objectId)
        this.db
          .prepare(
            'INSERT INTO external_observed VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,repo_id,stream,object_key) DO UPDATE SET subject_key=excluded.subject_key,body=excluded.body',
          )
          .run(sourceId, repoId, stream, observed.objectKey, observed.subjectKey, encode(observed))
      }
      this.writePollCheckpoints({ sourceId, repoId, stream }, checkpoints)
      const stored = events.map((event) => {
        if (event.sourceId !== sourceId || event.subject.repoId !== repoId)
          throw new Error('采集页与事件的仓库不符')
        return this.insertInboxEvent(event)
      })
      this.db
        .prepare(
          'INSERT INTO external_cursor VALUES(?,?,?,?) ON CONFLICT(source_id,repo_id,stream) DO UPDATE SET body=excluded.body',
        )
        .run(sourceId, repoId, stream, encode(cursor))
      return stored
    })
  }

  pollCheckpoint<T extends object>(
    sourceId: string,
    repoId: string,
    stream: string,
    bucket: string,
    key: string,
  ): T | null {
    return decode(
      this.db
        .prepare(
          'SELECT body FROM external_poll_checkpoints WHERE source_id=? AND repo_id=? AND stream=? AND bucket=? AND checkpoint_key=?',
        )
        .get(sourceId, repoId, stream, bucket, key),
    )
  }

  pollCheckpoints<T extends object>(
    sourceId: string,
    repoId: string,
    stream: string,
    bucket: string,
  ): T[] {
    return this.db
      .prepare(
        'SELECT body FROM external_poll_checkpoints WHERE source_id=? AND repo_id=? AND stream=? AND bucket=? ORDER BY checkpoint_key',
      )
      .all(sourceId, repoId, stream, bucket)
      .map((row) => decode<T>(row))
  }

  /** 同一轮采集可写同仓库的共享检查点；不带仓库 ID 时为整个来源的状态。 */
  writePollCheckpoints(
    scope: { sourceId: string; repoId?: string; stream: string },
    checkpoints: readonly ExternalPollCheckpoint[],
  ): void {
    if (checkpoints.length === 0) return
    const { sourceId, repoId = '', stream } = scope
    if (scope.repoId !== undefined) requireExternalId(repoId)
    this.transaction(() => {
      for (const { bucket, key, value } of checkpoints) {
        if (value === null) {
          this.db
            .prepare(
              'DELETE FROM external_poll_checkpoints WHERE source_id=? AND repo_id=? AND stream=? AND bucket=? AND checkpoint_key=?',
            )
            .run(sourceId, repoId, stream, bucket, key)
        } else {
          this.db
            .prepare(
              'INSERT INTO external_poll_checkpoints VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,repo_id,stream,bucket,checkpoint_key) DO UPDATE SET body=excluded.body',
            )
            .run(sourceId, repoId, stream, bucket, key, encode(value))
        }
      }
    })
  }

  /** 按检查点键继续读取，供需要有界处理的来源队列使用。 */
  pollCheckpointPage<T extends object>(
    scope: { sourceId: string; repoId: string; stream: string },
    bucket: string,
    limit: number,
    after = '',
  ): { key: string; value: T }[] {
    return this.db
      .prepare(
        'SELECT checkpoint_key,body FROM external_poll_checkpoints WHERE source_id=? AND repo_id=? AND stream=? AND bucket=? AND checkpoint_key>? ORDER BY checkpoint_key LIMIT ?',
      )
      .all(scope.sourceId, scope.repoId, scope.stream, bucket, after, boundedLimit(limit))
      .map((row) => ({ key: String(row.checkpoint_key), value: decode<T>(row) }))
  }

  eventEvidence(eventKey: string): ExternalEvent | null {
    return decode(
      this.db.prepare('SELECT body FROM external_event_evidence WHERE event_key=?').get(eventKey),
    )
  }

  /** B 的原始动作不改写；供路由使用的当前标签快照和入箱同事务提交。 */
  recordRoutingEvidence(
    event: ExternalInboxEvent,
    evidence: {
      labelIds?: readonly string[]
      resolvedLabelId?: string
      addressedBotIds?: readonly string[]
    },
  ): void {
    const key = { sourceId: event.sourceId, repoId: event.subject.repoId, stream: 'github:intake' }
    if (this.pollCheckpoint(key.sourceId, key.repoId, key.stream, 'evidence', event.eventKey))
      return
    for (const id of [...(evidence.labelIds ?? []), ...(evidence.addressedBotIds ?? [])])
      requireExternalId(id)
    if (evidence.resolvedLabelId && !evidence.labelIds?.includes(evidence.resolvedLabelId))
      throw new Error('动作标签 ID 不属于已核验的标签集合')
    this.writePollCheckpoints(key, [{ bucket: 'evidence', key: event.eventKey, value: evidence }])
  }

  routingEvidence(
    row: ExternalInboxEvent,
  ): { event: ExternalEvent; addressedBotIds: string[] } | null {
    const event = this.eventEvidence(row.eventKey)
    if (!event) return null
    const proof = this.pollCheckpoint<{
      labelIds?: string[]
      resolvedLabelId?: string
      addressedBotIds?: string[]
    }>(row.sourceId, row.subject.repoId, 'github:intake', 'evidence', row.eventKey)
    return {
      event: {
        ...event,
        targetEvidence: {
          ...event.targetEvidence,
          ...(proof?.labelIds ? { labelIds: proof.labelIds } : {}),
          ...(proof?.resolvedLabelId ? { labelId: proof.resolvedLabelId } : {}),
        },
      },
      addressedBotIds: proof?.addressedBotIds ?? [],
    }
  }

  /** 复核已发生的撤销或内容改动，隔离同仓库的其他主题和来源。 */
  laterEventEvidence(event: ExternalInboxEvent): ExternalEvent[] {
    return this.db
      .prepare(`
      SELECT evidence.body FROM external_inbox AS inbox
        JOIN external_event_evidence AS evidence USING (event_key)
      WHERE inbox.source_id=? AND inbox.repo_id=? AND inbox.event_key<>?
        AND json_extract(evidence.body,'$.subjectKey')=?
        AND (json_extract(evidence.body,'$.occurredAt')>? OR (
          json_extract(evidence.body,'$.occurredAt')=? AND (inbox.seq>? OR
            json_extract(evidence.body,'$.kind') IN ('unassigned','unlabeled','review_request_removed'))))
      ORDER BY inbox.seq DESC
    `)
      .all(
        event.sourceId,
        event.subject.repoId,
        event.eventKey,
        event.subjectKey,
        event.occurredAt,
        event.occurredAt,
        event.seq,
      )
      .map((row) => decode<ExternalEvent>(row))
  }

  /** B 线仅在能区分不可读与已删除时写入该观察；不依赖评论正文。 */
  observationUnavailable(event: ExternalInboxEvent): boolean {
    const row = this.db
      .prepare(`
      SELECT json_extract(body,'$.unavailable') AS unavailable
      FROM external_observed
      WHERE source_id=? AND subject_key=? AND json_extract(body,'$.objectId')=?
      ORDER BY json_extract(body,'$.observedAt') DESC, rowid DESC LIMIT 1
    `)
      .get(event.sourceId, event.subjectKey, event.sourceEventId)
    return row?.unavailable === 'deleted' || row?.unavailable === 'revoked'
  }

  /** 额度按发送点记账，设备重启不清空；只读取仍在计额窗口的时间。 */
  deliveryBudgetTimes(scope: 'source' | 'actor', id: string, after: number): number[] {
    return this.db
      .prepare(`
      SELECT at FROM external_audit
      WHERE subject=? AND at>? AND json_extract(body,'$.action')='delivery_budget'
      ORDER BY at
    `)
      .all(`delivery:${scope}:${id}`, after)
      .map((row) => Number(row.at))
  }

  wasIntakeReassigned(event: ExternalInboxEvent, managerId: string): boolean {
    return Boolean(
      this.db
        .prepare(`
      SELECT 1 FROM external_audit AS audit, json_each(audit.body, '$.eventKeys') AS event
      WHERE audit.subject=? AND json_extract(audit.body,'$.action')='intake_reassigned'
        AND json_extract(audit.body,'$.managerId')=? AND event.value=?
      LIMIT 1
    `)
        .get(event.subjectKey, managerId, event.eventKey),
    )
  }

  agentPullInbox(subject: ExternalSubject): ExternalInboxEvent[] {
    return this.db
      .prepare(`
      SELECT seq,body FROM external_inbox
      WHERE repo_id=? AND reason='agent_pr_needs_link' AND json_extract(body,'$.subjectKey')=?
    `)
      .all(subject.repoId, externalSubjectKey(subject))
      .map((row) => numbered<ExternalInboxEvent>(row))
  }

  /** 停止跟进或终态处理时关闭已入队的绑定提醒，之后恢复跟进也不补发这批。 */
  stopIssueDeliveries(
    managerId: string,
    issueId: ExternalIssueId,
    at: number,
    reason: string,
  ): void {
    this.transaction(() => {
      for (const group of this.queue.deliveryGroups(managerId, 'queued')) {
        if (group.issueId !== issueId) continue
        this.queue.finishDelivery(group.groupId, 'blocked', at, { reason })
        for (const key of group.eventKeys) {
          const event = this.inboxEvent(key)
          if (
            event?.status === 'received' &&
            event.issueId === issueId &&
            event.managerId === managerId
          )
            this.updateInboxEvent(key, event.revision, { status: 'processed', reason })
        }
      }
    })
  }

  /** 已在 B 入账但迟于恢复才分拣的事件，也按观察时的跟进状态决定是否补发。 */
  issueFollowUpOffAt(managerId: string, issueId: ExternalIssueId, observedAt: number): boolean {
    const row = this.db
      .prepare(`
      SELECT json_extract(body,'$.after.followUp.state') AS state FROM issue_history
      WHERE manager_id=? AND json_extract(body,'$.objectId')=?
        AND json_extract(body,'$.after.followUp.changedAt')<=?
        AND EXISTS (SELECT 1 FROM json_each(body,'$.fields') WHERE value='followUp')
      ORDER BY json_extract(body,'$.after.followUp.changedAt') DESC,rowid DESC LIMIT 1
    `)
      .get(managerId, issueId, observedAt)
    return row?.state === 'off'
  }

  inboxEvent(eventKey: string): ExternalInboxEvent | null {
    return numbered(
      this.db.prepare('SELECT seq, body FROM external_inbox WHERE event_key=?').get(eventKey),
    )
  }

  insertInboxEvent(event: NewExternalInboxEvent): ExternalStored<ExternalInboxEvent> {
    return this.transaction(() => {
      const existing = this.inboxEvent(event.eventKey)
      if (existing) return { inserted: false, record: existing }
      requireExternalId(event.sourceEventId)
      if (event.actorId !== null) requireExternalId(event.actorId)
      this.checkSubject(event.subject, event.subjectKey)
      const { evidence, ...publicEvent } = event
      if (
        evidence &&
        (!isExternalEvent(evidence) ||
          evidence.externalEventKey !== event.eventKey ||
          evidence.subjectKey !== event.subjectKey ||
          externalSubjectKey(evidence.targetEvidence.subject) !== event.subjectKey ||
          evidence.kind !== event.kind ||
          evidence.occurredAt !== event.occurredAt ||
          evidence.permalink !== event.eventUrl ||
          evidence.contentVersion !== event.contentVersion ||
          evidence.targetEvidence.sourceEventId !== event.sourceEventId ||
          (evidence.actorEvidence?.userId ?? null) !== event.actorId)
      )
        throw new Error('事件与平台证据不符')
      const record = { ...publicEvent, revision: 1 }
      const result = this.db
        .prepare(
          'INSERT INTO external_inbox(event_key,source_id,repo_id,manager_id,status,reason,body) VALUES(?,?,?,?,?,?,?) RETURNING seq',
        )
        .get(
          event.eventKey,
          event.sourceId,
          event.subject.repoId,
          event.managerId ?? null,
          event.status,
          event.reason ?? null,
          encode(record),
        )
      if (evidence)
        this.db
          .prepare('INSERT INTO external_event_evidence VALUES(?,?)')
          .run(event.eventKey, encode(evidence))
      this.appendAudit({
        at: event.observedAt,
        subject: event.subjectKey,
        action: 'inbox_received',
        state: event.status,
        eventKeys: [event.eventKey],
      })
      return { inserted: true, record: { ...record, seq: Number(requireRow(result).seq) } }
    })
  }

  updateInboxEvent(
    eventKey: string,
    expectedRevision: number,
    patch: Partial<
      Pick<
        ExternalInboxEvent,
        | 'actorRoleAtCheck'
        | 'ruleId'
        | 'rulesVersion'
        | 'routeId'
        | 'managerId'
        | 'issueId'
        | 'intakeId'
        | 'reason'
        | 'status'
        | 'contentVersion'
      >
    >,
  ): ExternalConfigResult<ExternalInboxEvent> {
    return this.transaction(() => {
      const before = this.inboxEvent(eventKey)
      if (!before || before.revision !== expectedRevision)
        return { outcome: 'conflict', record: before }
      const record = { ...before, ...patch, revision: before.revision + 1 }
      this.db
        .prepare(
          'UPDATE external_inbox SET manager_id=?,status=?,reason=?,body=? WHERE event_key=?',
        )
        .run(
          record.managerId ?? null,
          record.status,
          record.reason ?? null,
          encode(record),
          eventKey,
        )
      this.appendAudit({
        at: managerNow(),
        subject: before.subjectKey,
        action: 'inbox_updated',
        eventKeys: [eventKey],
        previousState: before.status,
        state: record.status,
      })
      return { outcome: 'applied', record }
    })
  }

  inbox(query: ExternalInboxQuery = {}): ExternalPage<ExternalInboxEvent> {
    const { sql, bindings } = where([
      ['seq<?', query.beforeSeq],
      ['source_id=?', query.sourceId],
      ['manager_id=?', query.managerId],
      ['repo_id=?', query.repoId],
      ['status=?', query.status],
      [
        'status IN (SELECT value FROM json_each(?))',
        query.statuses ? JSON.stringify(query.statuses) : undefined,
      ],
      ['reason=?', query.reason],
    ])
    const limit = boundedLimit(query.limit)
    const entries = this.db
      .prepare(`SELECT seq,body FROM external_inbox ${sql} ORDER BY seq DESC LIMIT ?`)
      .all(...bindings, limit + 1)
      .map((row) => numbered<ExternalInboxEvent>(row))
    return page(entries, limit)
  }

  inboxPending(sourceId: string, managerId?: string): number {
    return Number(
      this.db
        .prepare(`SELECT count(*) AS count FROM external_intakes
      WHERE status='pending_triage' AND json_extract(body,'$.sourceId')=?
      AND (? IS NULL OR manager_id=?)`)
        .get(sourceId, managerId ?? null, managerId ?? null)?.count ?? 0,
    )
  }

  inboxFingerprint(sourceId: string): string {
    const changes = this.db
      .prepare(`SELECT count(*) AS count, max(seq) AS latest,
      sum(json_extract(body,'$.revision')) AS revisions FROM external_inbox WHERE source_id=?`)
      .get(sourceId)
    const deliveries = this.db
      .prepare(`SELECT state, count(*) AS count FROM external_deliveries
      WHERE json_extract(body,'$.sourceId')=? GROUP BY state ORDER BY state`)
      .all(sourceId)
    return JSON.stringify([changes, deliveries])
  }

  /** 已待发的绑定提醒属于投递调度，不占分类重试的批次。 */
  unclassifiedInbox(sourceId: string, beforeSeq?: number): ExternalPage<ExternalInboxEvent> {
    const limit = 100
    const { sql, bindings } = where([
      ['source_id=?', sourceId],
      ['seq<?', beforeSeq],
    ])
    const entries = this.db
      .prepare(`
      SELECT seq,body FROM external_inbox ${sql} AND status='received'
        AND (reason IS NULL OR reason<>'awaiting_delivery')
      ORDER BY seq DESC LIMIT ?
    `)
      .all(...bindings, limit + 1)
      .map((row) => numbered<ExternalInboxEvent>(row))
    return page(entries, limit)
  }

  checkSubject(subject: ExternalSubject, key = externalSubjectKey(subject)): void {
    requireExternalId(subject.repoId)
    requireExternalId(subject.number)
    if (key !== externalSubjectKey(subject)) throw new Error('外部主题键与定位不符')
  }

  intake(intakeId: string): ExternalIntake | null {
    return decode(
      this.db.prepare('SELECT body FROM external_intakes WHERE intake_id=?').get(intakeId),
    )
  }

  pendingIntake(subjectKey: string, managerId?: string): ExternalIntake | null {
    return decode(
      this.db
        .prepare(
          "SELECT body FROM external_intakes WHERE subject_key=? AND coalesce(manager_id,'')=? AND status='pending_triage'",
        )
        .get(subjectKey, managerId ?? ''),
    )
  }

  /** 轮询当前状态与正文版本分开保存；旧分页不能把重新打开的主题覆盖成关闭。 */
  observeSubject(sourceId: string, observation: ExternalSubjectObservation, at: number): void {
    this.transaction(() => {
      const { subject, updatedAt } = observation
      const subjectKey = externalSubjectKey(subject)
      this.checkSubject(subject, subjectKey)
      const key = { sourceId, repoId: subject.repoId, stream: 'github:subject-state' }
      const previous = this.pollCheckpoint<ExternalSubjectObservation>(
        sourceId,
        subject.repoId,
        key.stream,
        'subject',
        subjectKey,
      )
      if (previous && previous.updatedAt > updatedAt) return
      this.writePollCheckpoints(key, [{ bucket: 'subject', key: subjectKey, value: observation }])
      const pending = this.db
        .prepare(
          "SELECT body FROM external_intakes WHERE subject_key=? AND status='pending_triage' AND json_extract(body,'$.sourceId')=?",
        )
        .all(subjectKey, sourceId)
      for (const row of pending) {
        const intake = decode<ExternalIntake>(row)
        if (intake) this.finishClosedIntake(intake, observation, at)
      }
    })
  }

  private finishClosedIntake(
    intake: ExternalIntake,
    observation: ExternalSubjectObservation,
    at: number,
  ): ExternalIntake {
    if (observation.state === 'open' || intake.issueId || this.ref(intake.subject)) return intake
    const events = intake.eventKeys.map((key) => this.inboxEvent(key))
    // 比状态快照更新的请求须等下一次平台观察，不能被旧关闭状态结算。
    if (events.some((event) => !event || event.occurredAt > observation.updatedAt)) return intake
    const reason = observation.state === 'merged' ? 'external_merged' : 'external_closed'
    const record: ExternalIntake = {
      ...intake,
      status: 'processed',
      reason,
      revision: intake.revision + 1,
    }
    this.writeIntake(record)
    if (intake.deliveryId && this.queue.deliveryGroup(intake.deliveryId)?.state === 'queued')
      this.queue.finishDelivery(intake.deliveryId, 'blocked', at, { reason })
    for (const event of events) {
      if (!event || event.intakeId !== intake.intakeId) throw new Error('候选事件在关闭时不一致')
      this.updateInboxEvent(event.eventKey, event.revision, { status: 'processed', reason })
    }
    this.appendAudit({
      at,
      subject: intake.subjectKey,
      action: 'intake_obsoleted',
      ...(intake.managerId ? { managerId: intake.managerId } : {}),
      eventKeys: intake.eventKeys,
      previousState: intake.status,
      state: record.status,
      reason,
    })
    return record
  }

  /** C 线在同一事务里更新事件到候选的索引。重复出现的证据不增加版本。 */
  collectIntake(candidate: Omit<ExternalIntake, 'revision' | 'status'>): ExternalIntake {
    return this.transaction(() => {
      this.checkSubject(candidate.subject, candidate.subjectKey)
      const existing = this.pendingIntake(candidate.subjectKey, candidate.managerId)
      if (!existing && this.intake(candidate.intakeId)) throw new Error('候选 ID 已存在')
      const eventKeys = [...new Set([...(existing?.eventKeys ?? []), ...candidate.eventKeys])]
      if (!eventKeys.length) throw new Error('候选缺少事件证据')
      if (existing && eventKeys.length === existing.eventKeys.length) return existing
      const record: ExternalIntake = {
        ...(existing ?? candidate),
        eventKeys,
        status: 'pending_triage',
        revision: (existing?.revision ?? 0) + 1,
        autoNotifyUntil: Math.max(existing?.autoNotifyUntil ?? 0, candidate.autoNotifyUntil),
      }
      this.writeIntake(record)
      for (const key of candidate.eventKeys) {
        const event = this.inboxEvent(key)
        if (
          !event ||
          event.subjectKey !== record.subjectKey ||
          event.sourceId !== record.sourceId ||
          (event.intakeId && event.intakeId !== record.intakeId) ||
          !['received', 'pending_triage'].includes(event.status)
        )
          throw new Error('候选与入箱事件不符')
        if (event.intakeId === record.intakeId && event.status === 'pending_triage') continue
        this.updateInboxEvent(key, event.revision, {
          intakeId: record.intakeId,
          status: 'pending_triage',
          ...(record.managerId === undefined ? {} : { managerId: record.managerId }),
        })
      }
      const observation = this.pollCheckpoint<ExternalSubjectObservation>(
        record.sourceId,
        record.subject.repoId,
        'github:subject-state',
        'subject',
        record.subjectKey,
      )
      return observation ? this.finishClosedIntake(record, observation, managerNow()) : record
    })
  }

  updateIntakeDelivery(
    intakeId: string,
    expectedRevision: number,
    deliveryId: string,
  ): ExternalConfigResult<ExternalIntake> {
    return this.transaction(() => {
      const before = this.intake(intakeId)
      const delivery = this.queue.deliveryGroup(deliveryId)
      if (
        !before ||
        !delivery ||
        before.revision !== expectedRevision ||
        before.status !== 'pending_triage' ||
        delivery.managerId !== before.managerId ||
        delivery?.subjectKey !== before.subjectKey
      )
        return { outcome: 'conflict', record: before }
      const record = { ...before, deliveryId, revision: before.revision + 1 }
      this.writeIntake(record)
      return { outcome: 'applied', record }
    })
  }

  /** 仅设备管理员可调用；按已核验的待分拣归属改派，目标已有同主题时合并证据。 */
  reassignIntake(input: {
    intakeId: string
    expectedRevision: number
    idempotencyKey: string
    managerId: string
    actorId: string
    at: number
  }): ExternalTriageResult {
    return this.transaction(() => {
      const before = this.intake(input.intakeId)
      if (!before) throw new Error('候选不存在')
      const sig = signature({ ...input, action: 'reassign', at: undefined })
      const previous = this.db
        .prepare(
          'SELECT signature,body FROM external_triage_requests WHERE intake_id=? AND idem_key=?',
        )
        .get(input.intakeId, input.idempotencyKey)
      if (previous)
        return previous.signature === sig
          ? decode<ExternalTriageResult>(previous)
          : { outcome: 'conflict', reason: 'idempotency', intake: before }
      if (before.revision !== input.expectedRevision || before.status !== 'pending_triage')
        return { outcome: 'conflict', reason: 'intake_revision', intake: before }
      const ref = this.ref(before.subject)
      if (ref) return { outcome: 'conflict', reason: 'binding', intake: before, ref }
      if (this.manager.manager(input.managerId)?.status !== 'active')
        throw new Error('改派目标不是有效经理')
      if (before.managerId === input.managerId) return { outcome: 'applied', intake: before }
      if (before.deliveryId && this.queue.deliveryGroup(before.deliveryId)?.state === 'queued')
        this.queue.finishDelivery(before.deliveryId, 'blocked', input.at, {
          reason: 'intake_reassigned',
        })
      const target = this.pendingIntake(before.subjectKey, input.managerId)
      if (target && target.sourceId !== before.sourceId) throw new Error('同主题候选来自不同配置')
      if (target)
        this.writeIntake({
          ...before,
          status: 'processed',
          reason: 'reassigned',
          revision: before.revision + 1,
        })
      const intake: ExternalIntake = target
        ? {
            ...target,
            eventKeys: [...new Set([...target.eventKeys, ...before.eventKeys])],
            autoNotifyUntil: Math.max(target.autoNotifyUntil, before.autoNotifyUntil),
            revision: target.revision + 1,
          }
        : { ...before, managerId: input.managerId, revision: before.revision + 1 }
      if (!target) delete intake.deliveryId
      this.writeIntake(intake)
      for (const key of before.eventKeys) {
        const event = this.inboxEvent(key)
        if (!event || event.intakeId !== before.intakeId) throw new Error('候选事件在改派时不一致')
        this.updateInboxEvent(key, event.revision, {
          managerId: input.managerId,
          intakeId: intake.intakeId,
        })
      }
      const result = { outcome: 'applied', intake } satisfies ExternalTriageResult
      this.db
        .prepare('INSERT INTO external_triage_requests VALUES(?,?,?,?,NULL)')
        .run(input.intakeId, input.idempotencyKey, sig, encode(result))
      this.appendAudit({
        at: input.at,
        subject: before.subjectKey,
        action: 'intake_reassigned',
        actorId: input.actorId,
        managerId: input.managerId,
        eventKeys: before.eventKeys,
      })
      return result
    })
  }

  private writeIntake(record: ExternalIntake): void {
    this.db
      .prepare(
        'INSERT INTO external_intakes VALUES(?,?,?,?,?) ON CONFLICT(intake_id) DO UPDATE SET manager_id=excluded.manager_id,status=excluded.status,body=excluded.body',
      )
      .run(
        record.intakeId,
        record.subjectKey,
        record.managerId ?? null,
        record.status,
        encode(record),
      )
  }

  ref(subject: Pick<ExternalSubject, 'provider' | 'repoId' | 'number'>): ExternalRef | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_refs WHERE provider=? AND repo_id=? AND number=?')
        .get(subject.provider, subject.repoId, subject.number),
    )
  }

  refs(managerId: string, issueId: ExternalIssueId): ExternalRef[] {
    return this.db
      .prepare('SELECT body FROM external_refs WHERE manager_id=? AND issue_id=? ORDER BY rowid')
      .all(managerId, issueId)
      .map((row) => decode<ExternalRef>(row))
  }

  refsForRepo(repoId: string): ExternalRef[] {
    return this.db
      .prepare("SELECT body FROM external_refs WHERE provider='github' AND repo_id=?")
      .all(repoId)
      .map((row) => decode<ExternalRef>(row))
  }

  issueFields(managerId: string, issueId: ExternalIssueId): ExternalIssueFields {
    const externalRefs = this.refs(managerId, issueId)
    const intakeMandates = this.mandates(managerId, issueId)
    return {
      ...(externalRefs.length ? { externalRefs } : {}),
      ...(intakeMandates.length ? { intakeMandates } : {}),
    }
  }

  /** 仓库改名只更新经设备核对过的定位缓存，保留原绑定。 */
  refreshRefLocation(subject: ExternalSubject): ExternalRef | null {
    return this.transaction(() => {
      this.checkSubject(subject)
      const before = this.ref(subject)
      if (!before || before.kind !== subject.kind) return null
      if (before.url === subject.url) return before
      const record = { ...before, url: subject.url }
      this.db
        .prepare('UPDATE external_refs SET body=? WHERE provider=? AND repo_id=? AND number=?')
        .run(encode(record), subject.provider, subject.repoId, subject.number)
      this.appendAudit({
        at: managerNow(),
        subject: externalSubjectKey(record),
        action: 'ref_location_changed',
        managerId: before.managerId,
        issueId: before.issueId,
      })
      return record
    })
  }

  bindRef(ref: ExternalRef): ExternalStored<ExternalRef> {
    return this.transaction(() => {
      this.checkSubject(ref)
      const existing = this.ref(ref)
      if (existing) return { inserted: false, record: existing }
      this.db
        .prepare('INSERT INTO external_refs VALUES(?,?,?,?,?,?)')
        .run(ref.provider, ref.repoId, ref.number, ref.managerId, ref.issueId, encode(ref))
      this.appendAudit({
        at: ref.createdAt,
        subject: externalSubjectKey(ref),
        action: 'ref_bound',
        managerId: ref.managerId,
        issueId: ref.issueId,
      })
      return { inserted: true, record: ref }
    })
  }

  mandate(mandateId: string): ExternalMandate | null {
    return decode(
      this.db.prepare('SELECT body FROM external_mandates WHERE mandate_id=?').get(mandateId),
    )
  }

  mandates(managerId: string, issueId: ExternalIssueId): ExternalMandate[] {
    return this.db
      .prepare(
        'SELECT body FROM external_mandates WHERE manager_id=? AND issue_id=? ORDER BY rowid',
      )
      .all(managerId, issueId)
      .map((row) => decode<ExternalMandate>(row))
  }

  revokeMandate(mandateId: string, actorId: string, at: number): ExternalMandate | null {
    return this.transaction(() => {
      const before = this.mandate(mandateId)
      if (!before || before.revokedAt !== undefined) return before
      const record = { ...before, revokedAt: at }
      this.db
        .prepare('UPDATE external_mandates SET body=? WHERE mandate_id=?')
        .run(encode(record), mandateId)
      this.appendAudit({
        at,
        subject: before.subjectKey,
        action: 'mandate_revoked',
        actorId,
        managerId: before.managerId,
        issueId: before.issueId,
      })
      return record
    })
  }

  /** 调用方须先检查处置记录归属；成功回执可在重新查 GitHub 前出示。 */
  triageResult(intakeId: string, idempotencyKey: string): ExternalTriageResult | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_triage_requests WHERE intake_id=? AND idem_key=?')
        .get(intakeId, idempotencyKey),
    )
  }

  /** 仅由通过再次核验身份、路由、规则与外部证据的设备入口调用。 */
  commitTriage(input: ExternalTriageCommit, hooks: ExternalTriageHooks = {}): ExternalTriageResult {
    return this.transaction(() => {
      const before = this.intake(input.intakeId)
      if (!before || before.managerId !== input.managerId) throw new Error('没有该经理可处置的候选')
      const ref = this.ref(before.subject)
      const conflict = (
        reason: Extract<ExternalTriageResult, { outcome: 'conflict' }>['reason'],
      ): ExternalTriageResult => ({
        outcome: 'conflict',
        reason,
        intake: before,
        ...(ref ? { ref } : {}),
      })
      const sig = signature({
        ...input,
        at: undefined,
        evidence: undefined,
        reply:
          hooks.reply &&
          ('notQueued' in hooks.reply ? { notQueued: true } : hooks.reply.payloadHash),
      })
      const previous = this.db
        .prepare(
          'SELECT signature,body FROM external_triage_requests WHERE intake_id=? AND idem_key=?',
        )
        .get(input.intakeId, input.idempotencyKey)
      if (previous)
        return previous.signature === sig
          ? decode<ExternalTriageResult>(previous)
          : conflict('idempotency')
      if (input.expectedRevision !== before.revision || before.status !== 'pending_triage')
        return conflict('intake_revision')
      if (input.action !== 'ignore' && this.manager.manager(input.managerId)?.status !== 'active')
        throw new Error('当前经理不能处置外部候选')

      let issueId: ExternalIssueId | undefined
      let actualRef: ExternalRef | undefined
      let mandate: ExternalMandate | undefined
      if (input.action !== 'ignore') {
        const { evidence } = input
        requireExternalId(evidence.requesterUserId)
        if (
          !evidence.eventKeys.length ||
          evidence.eventKeys.some((key) => !before.eventKeys.includes(key)) ||
          evidence.authorizedScope.subjectKey !== before.subjectKey ||
          evidence.authorizedScope.repoId !== before.subject.repoId
        )
          throw new Error('受理依据不属于该候选')
        if (input.action === 'accept') {
          const related = input.relatedIssueId
          // 已结束的 X-n 可以有内部后续议题，外部主题仍指向原绑定。
          if (ref) {
            const original =
              ref.managerId === input.managerId
                ? (this.manager.issue(input.managerId, ref.issueId) as ManagerIssue | null)
                : null
            if (
              !related ||
              related !== ref.issueId ||
              !original ||
              !['resolved', 'closed'].includes(original.status)
            )
              return conflict('binding')
          } else if (related && !this.manager.issue(input.managerId, related)) {
            return conflict('issue_revision')
          }
          issueId = this.manager.nextIssueId(input.managerId)
          this.createIssue(issueId, input)
          hooks.onCreate?.(this.manager.issue(input.managerId, issueId) as ManagerIssue, related)
        } else {
          issueId = input.issueId
          if (ref && (ref.managerId !== input.managerId || ref.issueId !== issueId))
            return conflict('binding')
          const existing = this.manager.issue(input.managerId, issueId) as ManagerIssue | null
          const meta = this.manager.issueMeta(input.managerId, issueId) as {
            revision?: number
          } | null
          if (
            existing?.kind !== 'ordinary' ||
            existing.revision + (meta?.revision ?? 0) !== input.expectedIssueRevision
          )
            return conflict('issue_revision')
          this.manager.saveIssue(input.managerId, issueId, {
            ...existing,
            revision: existing.revision + 1,
            updatedAt: input.at,
          })
        }
        actualRef =
          ref ??
          this.bindRef({
            ...before.subject,
            managerId: input.managerId,
            issueId,
            origin: 'intake',
            createdAt: input.at,
          }).record
        mandate = {
          ...evidence,
          mandateId: randomUUID(),
          managerId: input.managerId,
          issueId,
          subjectKey: before.subjectKey,
          decision: input.action,
          acceptedBy: input.actorId,
          acceptedAt: input.at,
        }
        this.db
          .prepare('INSERT INTO external_mandates VALUES(?,?,?,?)')
          .run(mandate.mandateId, mandate.managerId, mandate.issueId, encode(mandate))
      }
      const intake: ExternalIntake = {
        ...before,
        ...(issueId ? { issueId } : {}),
        status: 'processed',
        revision: before.revision + 1,
        ...(input.action === 'ignore' ? { reason: 'ignored' } : {}),
      }
      this.writeIntake(intake)
      if (before.deliveryId && this.queue.deliveryGroup(before.deliveryId)?.state === 'queued')
        this.queue.finishDelivery(before.deliveryId, 'blocked', input.at, {
          reason: 'intake_processed',
        })
      for (const key of before.eventKeys) {
        const event = this.inboxEvent(key)
        if (!event || event.intakeId !== intake.intakeId) throw new Error('候选事件在处置时不一致')
        this.updateInboxEvent(key, event.revision, {
          status: 'processed',
          ...(issueId ? { issueId } : {}),
          ...(input.action === 'ignore' ? { reason: 'ignored' } : {}),
        })
      }
      const reply = hooks.reply
      let replyResult: Extract<ExternalTriageResult, { outcome: 'applied' }>['reply']
      if (reply && 'notQueued' in reply) replyResult = reply
      else if (reply) {
        if (
          input.managerId === undefined ||
          reply.sourceId !== before.sourceId ||
          reply.managerId !== input.managerId ||
          externalSubjectKey(reply.targetRef) !== before.subjectKey ||
          reply.action !== 'comment'
        )
          throw new Error('受理回复必须发往原主题')
        const queued = this.queue.enqueueOutbox({
          ...reply,
          ...(issueId ? { issueId } : {}),
          intakeId: before.intakeId,
          ...(mandate ? { mandateId: mandate.mandateId } : {}),
        })
        if (
          !queued.inserted &&
          (queued.record.managerId !== input.managerId ||
            queued.record.intakeId !== before.intakeId ||
            queued.record.payloadHash !== reply.payloadHash)
        )
          throw new Error('回复的幂等键已用于另一项操作')
        replyResult = { operationId: queued.record.operationId }
      }
      const result = {
        outcome: 'applied',
        intake,
        ...(actualRef ? { ref: actualRef } : {}),
        ...(mandate ? { mandate } : {}),
        ...(replyResult ? { reply: replyResult } : {}),
      } satisfies ExternalTriageResult
      this.db
        .prepare('INSERT INTO external_triage_requests VALUES(?,?,?,?,?)')
        .run(
          input.intakeId,
          input.idempotencyKey,
          sig,
          encode(result),
          input.action === 'ignore' ? input.reason : null,
        )
      this.appendAudit({
        at: input.at,
        subject: before.subjectKey,
        action: input.action,
        actorId: input.actorId,
        ...(input.managerId ? { managerId: input.managerId } : {}),
        eventKeys: before.eventKeys,
        ...(issueId ? { issueId } : {}),
        ...(input.action === 'ignore' ? { reason: 'ignored' } : {}),
      })
      return result
    })
  }

  private createIssue(
    id: ExternalIssueId,
    creation: Extract<ExternalTriageCommit, { action: 'accept' }>,
  ): void {
    const { managerId, title, body, at } = creation
    if (!title.trim()) throw new Error('受理须提供本地议题标题')
    const issue: ManagerIssue = {
      id,
      kind: 'ordinary',
      title,
      body,
      status: 'open',
      stateGroup: 'open',
      author: { kind: 'manager' },
      revision: 1,
      createdAt: at,
      updatedAt: at,
      followUp: { state: 'on', changedAt: at, changedBy: 'manager' },
      discussion: { comments: [], questions: [], summary: null },
      relations: [],
      timeline: [],
      quick: {},
      unread: false,
    }
    this.manager.saveIssue(managerId, id, issue)
    this.manager.recordIssue(managerId, id, 'manager', null, issue, 'Accepted an external intake')
  }

  runWatch(repoId: string, runId: string, attempt: number): ExternalRunWatch | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_run_watches WHERE repo_id=? AND run_id=? AND attempt=?')
        .get(repoId, runId, attempt),
    )
  }

  runWatches(repoId?: string): ExternalRunWatch[] {
    const { sql, bindings } = where([['repo_id=?', repoId]])
    return this.db
      .prepare(`SELECT body FROM external_run_watches ${sql} ORDER BY rowid`)
      .all(...bindings)
      .map((row) => decode<ExternalRunWatch>(row))
  }

  saveRunWatch(watch: ExternalRunWatch): void {
    for (const id of [watch.repoId, watch.runId, watch.workflowId]) requireExternalId(id)
    this.checkSubject(watch.prRef)
    if (
      !Number.isSafeInteger(watch.attempt) ||
      watch.attempt < 1 ||
      watch.prRef.kind !== 'pull_request' ||
      watch.prRef.repoId !== watch.repoId
    )
      throw new Error('CI 观察缺少准确的仓库或运行次数')
    this.db
      .prepare(
        'INSERT INTO external_run_watches VALUES(?,?,?,?) ON CONFLICT(repo_id,run_id,attempt) DO UPDATE SET body=excluded.body',
      )
      .run(watch.repoId, watch.runId, watch.attempt, encode(watch))
  }

  appendAudit(entry: ExternalAuditEntry): number {
    const {
      at,
      subject,
      action,
      actorId,
      reason,
      previousState,
      state,
      rulesVersion,
      role,
      managerId,
      issueId,
      eventKeys,
      operationId,
      policyRevision,
    } = entry
    return Number(
      this.db.prepare('INSERT INTO external_audit(at,subject,body) VALUES(?,?,?)').run(
        at,
        subject,
        encode({
          at,
          subject,
          action,
          actorId,
          reason,
          previousState,
          state,
          rulesVersion,
          role,
          managerId,
          issueId,
          eventKeys,
          operationId,
          policyRevision,
        }),
      ).lastInsertRowid,
    )
  }

  audit(
    subject: string,
    beforeSeq?: number,
    limit = 50,
  ): Array<ExternalAuditEntry & { seq: number }> {
    const { sql, bindings } = where([
      ['subject=?', subject],
      ['seq<?', beforeSeq],
    ])
    return this.db
      .prepare(`SELECT seq,body FROM external_audit ${sql} ORDER BY seq DESC LIMIT ?`)
      .all(...bindings, boundedLimit(limit))
      .map((row) => numbered<ExternalAuditEntry & { seq: number }>(row))
  }
}
