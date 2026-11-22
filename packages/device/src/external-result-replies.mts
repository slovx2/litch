// 结果回复的证明与一次性提醒在经理数据库内提交，不依赖模型输出或回合记忆。
import {
  type ExternalIssueId,
  type ExternalMissingResultReply,
  type ExternalRef,
  type ExternalSubject,
  externalSubjectKey,
} from '../../protocol/src/external-sources.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { ExternalOutboxRecord } from './external-store-records.mjs'
import type { ManagerStore } from './manager-store.mjs'

export const EXTERNAL_RESULT_REPLY_MIGRATION = `
CREATE TABLE external_result_replies(
  manager_id TEXT NOT NULL, issue_id TEXT NOT NULL, source_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, accepted_at INTEGER NOT NULL,
  receipt_id TEXT, report_notified INTEGER NOT NULL DEFAULT 0,
  terminal INTEGER NOT NULL DEFAULT 0, reminder_id TEXT, reminder_thread_id TEXT,
  PRIMARY KEY(manager_id,issue_id)
);
CREATE INDEX external_result_replies_source ON external_result_replies(source_id,terminal);
INSERT OR IGNORE INTO external_result_replies(manager_id,issue_id,source_id,subject_key,accepted_at)
SELECT m.manager_id,m.issue_id,i.source_id,json_extract(i.body,'$.subjectKey'),json_extract(m.body,'$.acceptedAt')
FROM external_mandates m
JOIN external_inbox i ON i.event_key=json_extract(m.body,'$.eventKeys[0]')
JOIN external_refs r ON r.manager_id=m.manager_id AND r.issue_id=m.issue_id
  AND r.provider='github' AND r.repo_id=i.repo_id AND CAST(r.number AS TEXT)=json_extract(i.body,'$.subject.number')
WHERE json_extract(i.body,'$.subjectKey')=json_extract(m.body,'$.subjectKey')
  AND json_extract(r.body,'$.kind')=json_extract(i.body,'$.subject.kind')
ORDER BY json_extract(m.body,'$.acceptedAt'),m.rowid;
-- 旧版没有用途字段；只沿用设备已经确认、直接发到原帖的经理评论回执。
UPDATE external_result_replies AS d SET receipt_id=(
  SELECT o.operation_id FROM external_outbox o
  WHERE o.manager_id=d.manager_id AND o.source_id=d.source_id AND o.subject_key=d.subject_key
    AND o.state='confirmed' AND json_extract(o.body,'$.action')='comment'
    AND json_extract(o.body,'$.issueId')=d.issue_id
    AND json_extract(o.body,'$.intakeId') IS NULL
    AND json_extract(o.body,'$.receipt.at')>=d.accepted_at
    AND json_extract(o.body,'$.mandateId') IS NOT NULL ORDER BY o.seq LIMIT 1
);
UPDATE external_result_replies AS d SET terminal=1,reminder_id=''
WHERE EXISTS(SELECT 1 FROM issues i WHERE i.manager_id=d.manager_id AND i.id=d.issue_id
  AND json_extract(i.body,'$.status') IN ('resolved','closed'))
OR EXISTS(SELECT 1 FROM external_refs r JOIN external_poll_checkpoints p
  ON p.repo_id=r.repo_id AND p.checkpoint_key='github/' || r.repo_id || '/' || r.number
  WHERE r.manager_id=d.manager_id AND r.issue_id=d.issue_id
  AND p.source_id=d.source_id AND p.stream='github:subject-state' AND p.bucket='subject'
  AND json_extract(p.body,'$.state')=CASE json_extract(r.body,'$.kind')
    WHEN 'pull_request' THEN 'merged' ELSE 'closed' END
  AND json_extract(p.body,'$.updatedAt')>=d.accepted_at);
`

/** GitHub 收尾证据与看板自身结束分开记，重启后不能把后者误当成前者。 */
export const EXTERNAL_ISSUE_STATUS_MIGRATION = `
ALTER TABLE external_result_replies ADD COLUMN github_terminal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE external_result_replies ADD COLUMN status_reminder_id TEXT;
ALTER TABLE external_result_replies ADD COLUMN status_reminder_thread_id TEXT;
UPDATE external_result_replies AS d SET github_terminal=1
WHERE EXISTS(SELECT 1 FROM external_refs r JOIN external_poll_checkpoints p
  ON p.repo_id=r.repo_id AND p.checkpoint_key='github/' || r.repo_id || '/' || r.number
  WHERE r.manager_id=d.manager_id AND r.issue_id=d.issue_id
  AND p.source_id=d.source_id AND p.stream='github:subject-state' AND p.bucket='subject'
  AND json_extract(p.body,'$.subject.kind')=json_extract(r.body,'$.kind')
  AND json_extract(p.body,'$.state') IN ('closed','merged')
  AND json_extract(p.body,'$.updatedAt')>=d.accepted_at);
`

export type ExternalReminderKind = 'reply' | 'status'
const statusNeedsReview = (status: unknown) => status === 'open' || status === 'in_progress'

interface ReplyRow {
  manager_id: string
  issue_id: ExternalIssueId
  source_id: string
  subject_key: string
  accepted_at: number
  receipt_id: string | null
  report_notified: number
  terminal: number
  reminder_id: string | null
  reminder_thread_id: string | null
  github_terminal: number
  status_reminder_id: string | null
  status_reminder_thread_id: string | null
}
export class ExternalResultReplies {
  private readonly manager: ManagerStore
  constructor(manager: ManagerStore) {
    this.manager = manager
  }
  private get db() {
    return this.manager.db
  }
  private row(managerId: string, issueId: string) {
    return this.db
      .prepare('SELECT * FROM external_result_replies WHERE manager_id=? AND issue_id=?')
      .get(managerId, issueId) as ReplyRow | undefined
  }
  private view(row: ReplyRow): ExternalMissingResultReply | null {
    const refRow = this.db
      .prepare(`SELECT body FROM external_refs WHERE manager_id=? AND issue_id=?
      AND 'github/' || repo_id || '/' || number=?`)
      .get(row.manager_id, row.issue_id, row.subject_key)
    if (typeof refRow?.body !== 'string') return null
    const { provider, repoId, number, kind, url } = JSON.parse(refRow.body) as ExternalRef
    return {
      managerId: row.manager_id,
      issueId: row.issue_id,
      subject: { provider, repoId, number, kind, url },
    }
  }
  accepted(
    managerId: string,
    issueId: ExternalIssueId,
    sourceId: string,
    subject: ExternalSubject,
    at: number,
  ): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO external_result_replies
      (manager_id,issue_id,source_id,subject_key,accepted_at) VALUES(?,?,?,?,?)`)
      .run(managerId, issueId, sourceId, externalSubjectKey(subject), at)
  }
  matches(
    managerId: string,
    issueId: ExternalIssueId,
    sourceId: string,
    subject: ExternalSubject,
  ): boolean {
    const row = this.row(managerId, issueId)
    return row?.source_id === sourceId && row.subject_key === externalSubjectKey(subject)
  }
  confirmed(entry: ExternalOutboxRecord): void {
    if (
      !entry.issueId ||
      !entry.resultReply ||
      entry.intakeId ||
      entry.action !== 'comment' ||
      entry.state !== 'confirmed' ||
      !entry.receipt
    )
      return
    const row = this.row(entry.managerId, entry.issueId)
    if (
      !row ||
      row.receipt_id ||
      entry.receipt.at < row.accepted_at ||
      row.source_id !== entry.sourceId ||
      row.subject_key !== externalSubjectKey(entry.targetRef)
    )
      return
    this.db
      .prepare('UPDATE external_result_replies SET receipt_id=? WHERE manager_id=? AND issue_id=?')
      .run(entry.operationId, entry.managerId, entry.issueId)
    if (row.reminder_id) this.manager.delivered(row.reminder_id)
  }
  finish(managerId: string, issueId: string, observedAt?: number): boolean {
    const row = this.row(managerId, issueId)
    if (!row || row.terminal || (observedAt !== undefined && observedAt < row.accepted_at))
      return false
    this.db
      .prepare('UPDATE external_result_replies SET terminal=1 WHERE manager_id=? AND issue_id=?')
      .run(managerId, issueId)
    return !row.receipt_id
  }
  finishSubject(sourceId: string, ref: ExternalRef, observedAt: number, merged: boolean): void {
    // 关闭但未合并的 PR 可以提醒核对看板，不触发原有的「未回原帖」检查。
    if (ref.kind === 'issue' || merged) this.finish(ref.managerId, ref.issueId, observedAt)
    this.db
      .prepare(`UPDATE external_result_replies SET github_terminal=1
      WHERE manager_id=? AND issue_id=? AND source_id=? AND accepted_at<=? AND github_terminal=0`)
      .run(ref.managerId, ref.issueId, sourceId, observedAt)
  }
  issueStatusChanged(managerId: string, issueId: string): void {
    const id = this.row(managerId, issueId)?.status_reminder_id
    if (!id) return
    this.db
      .prepare(
        "UPDATE external_result_replies SET status_reminder_id='' WHERE manager_id=? AND issue_id=?",
      )
      .run(managerId, issueId)
    this.manager.delivered(id)
  }
  missing(managerId: string, issueId: string): ExternalMissingResultReply | null {
    const row = this.row(managerId, issueId)
    return row?.terminal && !row.receipt_id ? this.view(row) : null
  }
  missingForSource(sourceId: string): ExternalMissingResultReply[] {
    return (
      this.db
        .prepare(`SELECT * FROM external_result_replies
      WHERE source_id=? AND terminal=1 AND receipt_id IS NULL ORDER BY rowid DESC LIMIT 100`)
        .all(sourceId) as unknown as ReplyRow[]
    ).flatMap((row) => this.view(row) ?? [])
  }
  reportHint(managerId: string, issueId: string) {
    const row = this.row(managerId, issueId)
    return row && !row.receipt_id && !row.report_notified && !row.terminal ? this.hint(row) : null
  }
  private hint(row: ReplyRow) {
    const reply = this.view(row)
    return reply ? { ...reply, sourceId: row.source_id, confirmed: false as const } : null
  }
  reportDelivered(hints: readonly ExternalMissingResultReply[]): void {
    if (!hints.length) return
    this.manager.transaction(() => {
      const update = this.db.prepare(
        'UPDATE external_result_replies SET report_notified=1 WHERE manager_id=? AND issue_id=?',
      )
      for (const hint of hints) update.run(hint.managerId, hint.issueId)
    })
  }
  /** 进队列和去重同事务；重启后仍由经理的持久队列投递。 */
  queueReminders(): void {
    this.manager.transaction(() => {
      const rows = this.db
        .prepare(`SELECT d.* FROM external_result_replies d JOIN managers m ON m.id=d.manager_id
        WHERE d.terminal=1 AND d.receipt_id IS NULL AND d.reminder_id IS NULL
        AND json_extract(m.body,'$.status')='active' LIMIT 100`)
        .all() as unknown as ReplyRow[]
      const update = this.db.prepare(
        'UPDATE external_result_replies SET reminder_id=? WHERE manager_id=? AND issue_id=?',
      )
      for (const row of rows) {
        const reply = this.hint(row)
        if (!reply) continue
        const id = this.manager.enqueue(
          row.manager_id,
          formatSessionEvent({
            kind: 'manager-issue',
            notes: [],
            manager: {
              managerId: row.manager_id,
              text: 'Litch checked for a confirmed result reply when the external issue or its work closed.',
            },
            externalResultReplies: [reply],
          }),
        )
        update.run(id, row.manager_id, row.issue_id)
      }
      const statusRows = this.db
        .prepare(`SELECT d.* FROM external_result_replies d JOIN managers m ON m.id=d.manager_id
        JOIN issues i ON i.manager_id=d.manager_id AND i.id=d.issue_id
        WHERE d.github_terminal=1 AND d.receipt_id IS NOT NULL AND d.status_reminder_id IS NULL
        AND json_extract(m.body,'$.status')='active'
        AND json_extract(i.body,'$.status') IN ('open','in_progress') LIMIT 100`)
        .all() as unknown as ReplyRow[]
      const mark = this.db.prepare(
        'UPDATE external_result_replies SET status_reminder_id=? WHERE manager_id=? AND issue_id=?',
      )
      for (const row of statusRows) {
        const ref = this.view(row)
        if (!ref) continue
        const id = this.manager.enqueue(
          row.manager_id,
          formatSessionEvent({
            kind: 'manager-issue',
            notes: [],
            manager: {
              managerId: row.manager_id,
              text: `${row.issue_id} (${ref.subject.url}) has a confirmed result reply on its original GitHub topic, and Litch observed a linked GitHub issue or PR closed or merged. Read issue_get and use issue_update to bring the board status up to date: resolve delivered work, close duplicates or superseded requests, or record what's still blocking it. This is only a board check; do not change GitHub state or post the result again for this reminder.`,
            },
            externalIssueStatusCheck: { issueId: row.issue_id },
          }),
        )
        mark.run(id, row.manager_id, row.issue_id)
      }
    })
  }
  pendingManagerIds(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT r.manager_id FROM external_result_replies r
      JOIN deliveries d ON d.id=r.reminder_id OR d.id=r.status_reminder_id`)
      .all()
      .map(({ manager_id }) => String(manager_id))
  }
  reminderTarget(managerId: string, issueId: string, kind: ExternalReminderKind): string | null {
    const row = this.row(managerId, issueId)
    return (kind === 'status' ? row?.status_reminder_thread_id : row?.reminder_thread_id) ?? null
  }
  attemptingReminder(
    managerId: string,
    issueId: string,
    threadId: string,
    kind: ExternalReminderKind,
  ): void {
    const field = kind === 'status' ? 'status_reminder_thread_id' : 'reminder_thread_id'
    this.db
      .prepare(`UPDATE external_result_replies SET ${field}=? WHERE manager_id=? AND issue_id=?`)
      .run(threadId, managerId, issueId)
  }
  reminderCurrent(
    managerId: string,
    issueId: string,
    deliveryId: string,
    kind: ExternalReminderKind,
  ): boolean {
    const row = this.row(managerId, issueId)
    if (kind === 'reply') return row?.reminder_id === deliveryId && !row.receipt_id
    if (row?.status_reminder_id !== deliveryId || !row.receipt_id || !row.github_terminal)
      return false
    const issue = this.manager.issue(managerId, issueId) as { status?: unknown } | null
    return statusNeedsReview(issue?.status)
  }
}
