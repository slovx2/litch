// 经理看板不能重建：迁移只往后加，审计记录只追加。对象和事件在同一事务内提交。
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Manager,
  ManagerActor,
  ManagerChange,
  ManagerDecision,
  ManagerItem,
  ManagerObjectId,
  ManagerRequest,
  ManagerSituation,
} from '../../protocol/src/manager.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

const MIGRATIONS = [
  `CREATE TABLE managers(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
   CREATE TABLE objects(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
   CREATE TABLE counters(manager_id TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(manager_id,kind));
   CREATE TABLE situations(manager_id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, manager_id TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX changes_manager ON changes(manager_id,seq);
   CREATE TABLE deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, manager_id TEXT NOT NULL, text TEXT NOT NULL);
   CREATE TABLE reports(thread_id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
  // 收尾回合与投递事件一起留存；重启后按事件原文找回回合，不能把普通回合误认作收尾。
  `CREATE TABLE endings(manager_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT);`,
  `CREATE TABLE questions(manager_id TEXT NOT NULL, decision_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,decision_id));`,
  `CREATE TABLE suggestion_reviews(proposal_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL, body TEXT NOT NULL);`,
  `CREATE TABLE manager_reports(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
   CREATE TABLE manager_suggestion_versions(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));`,
  `CREATE TABLE manager_relations(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));`,
  `CREATE TABLE manager_resets(manager_id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE manager_history(thread_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL);`,
] as const
export const MANAGER_SCHEMA_VERSION = MIGRATIONS.length
export const managerNow = () => Math.floor(Date.now() / 1000)
export type BoardObject = ManagerDecision | ManagerItem | ManagerRequest
export interface ManagerDelivery {
  id: string
  managerId: string
  text: string
}
export interface ManagerEnding {
  eventId: string
  text: string
  turnId: string | null
}
export interface QuestionState {
  managerId: string
  decisionId: import('../../protocol/src/manager-posts.mjs').ManagerPostId
  discussion: import('../../protocol/src/manager.mjs').ManagerDiscussion
  threadId: string | null
  /** 退休分叉的身份仍保留，迟到调用和重启都不能恢复写权限。 */
  threads: string[]
  source: string
  revision: number
}
export interface LineReport {
  text: string
  at: number
  turnId: string
  status: string
}
export interface ResetRecord {
  managerId: string
  oldThreadId: string
  phase: import('../../protocol/src/manager.mjs').ManagerResetState['phase']
  applied: string | null
  error?: string
  /** 已提交的换绑意图；跨库重放幂等，不声称 WAL 跨库原子。 */
  committed?: { manager: Manager; input: string }
  summaryTurnId?: string
  oldTools?: unknown[]
}

export function openManagerDatabase(stateDir: string): DatabaseSync {
  const path = join(stateDir, 'manager.sqlite')
  ensureParent(path)
  if (existsSync(path) && statSync(path).size > 0) assertStoreFormat(path)
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > MANAGER_SCHEMA_VERSION)
      throw new Error(`经理库版本 ${version} 高于支持的 ${MANAGER_SCHEMA_VERSION}，拒绝打开`)
    initializeStoreFormat(db)
    db.exec('PRAGMA journal_mode=WAL')
    for (let step = version; step < MANAGER_SCHEMA_VERSION; step++) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(MIGRATIONS[step] as string)
        db.exec(`PRAGMA user_version=${step + 1}`)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

const body = <T,>(row: Record<string, unknown> | undefined): T | null =>
  row ? (JSON.parse(String(row.body)) as T) : null

export class ManagerStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  managers(): Manager[] {
    return this.db
      .prepare('SELECT body FROM managers ORDER BY rowid')
      .all()
      .map((row) => body<Manager>(row) as Manager)
  }
  manager(id: string): Manager | null {
    return body(this.db.prepare('SELECT body FROM managers WHERE id=?').get(id))
  }
  forThread(threadId: string): Manager | null {
    return body(this.db.prepare('SELECT body FROM managers WHERE thread_id=?').get(threadId))
  }
  saveManager(manager: Manager): void {
    this.db
      .prepare(
        'INSERT INTO managers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(manager.id, manager.threadId, JSON.stringify(manager))
  }
  reset(id: string): ResetRecord | null {
    return body(this.db.prepare('SELECT body FROM manager_resets WHERE manager_id=?').get(id))
  }
  saveReset(record: ResetRecord): void {
    this.db
      .prepare(
        'INSERT INTO manager_resets VALUES(?,?) ON CONFLICT(manager_id) DO UPDATE SET body=excluded.body',
      )
      .run(record.managerId, JSON.stringify(record))
  }
  historical(threadId: string): Manager | null {
    const row = this.db
      .prepare('SELECT manager_id FROM manager_history WHERE thread_id=?')
      .get(threadId)
    return row ? this.manager(String(row.manager_id)) : null
  }
  history(id: string): string[] {
    return this.db
      .prepare('SELECT thread_id FROM manager_history WHERE manager_id=? ORDER BY rowid')
      .all(id)
      .map((row) => String(row.thread_id))
  }
  /** 会话树已按提交意图重放后，一笔事务更新索引、正文、临时追问和接班事件。 */
  finishRebind(record: ResetRecord): void {
    const committed = record.committed
    if (!committed) throw new Error('Missing committed manager rebind')
    this.transaction(() => {
      const after = committed.manager
      this.db
        .prepare('INSERT OR IGNORE INTO manager_history VALUES(?,?)')
        .run(record.oldThreadId, after.id)
      this.db
        .prepare('UPDATE managers SET thread_id=?, body=? WHERE id=?')
        .run(after.threadId, JSON.stringify(after), after.id)
      for (const state of this.questions(after.id)) {
        state.threadId = null
        this.saveQuestion(state)
      }
      // 接班提示必须是新经理首轮，重置期间用户答复等既有事件保持原顺序随后投递。
      this.db
        .prepare(
          'INSERT INTO deliveries(seq,id,manager_id,text) VALUES((SELECT coalesce(min(seq),1)-1 FROM deliveries),?,?,?)',
        )
        .run(randomUUID(), after.id, committed.input)
      this.record(
        after.id,
        'manager',
        'user',
        { threadId: record.oldThreadId },
        after,
        'Manager session reset',
      )
      this.saveReset({
        managerId: after.id,
        oldThreadId: after.threadId,
        phase: 'ready',
        applied: record.applied,
      })
    })
  }
  objects(managerId: string): BoardObject[] {
    return this.db
      .prepare('SELECT body FROM objects WHERE manager_id=? ORDER BY rowid')
      .all(managerId)
      .map((row) => body<BoardObject>(row) as BoardObject)
  }
  object(managerId: string, id: string): BoardObject | null {
    return body(
      this.db.prepare('SELECT body FROM objects WHERE manager_id=? AND id=?').get(managerId, id),
    )
  }
  saveObject(managerId: string, object: BoardObject): void {
    this.db
      .prepare(
        'INSERT INTO objects VALUES(?,?,?) ON CONFLICT(manager_id,id) DO UPDATE SET body=excluded.body',
      )
      .run(managerId, object.id, JSON.stringify(object))
  }
  suggestionReview(
    managerId: string,
    proposalId: string,
  ): import('../../protocol/src/suggestion-inbox.mjs').SuggestionReview | null {
    return body(
      this.db
        .prepare('SELECT body FROM suggestion_reviews WHERE proposal_id=? AND manager_id=?')
        .get(proposalId, managerId),
    )
  }
  saveSuggestionReview(
    managerId: string,
    proposalId: string,
    review: import('../../protocol/src/suggestion-inbox.mjs').SuggestionReview,
  ): void {
    this.db
      .prepare(
        'INSERT INTO suggestion_reviews VALUES(?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET manager_id=excluded.manager_id, body=excluded.body',
      )
      .run(proposalId, managerId, JSON.stringify(review))
  }
  relations(managerId: string): import('../../protocol/src/manager-posts.mjs').ManagerRelation[] {
    return this.db
      .prepare('SELECT body FROM manager_relations WHERE manager_id=? ORDER BY rowid')
      .all(managerId)
      .map((row) => JSON.parse(String(row.body)))
  }
  saveRelation(
    managerId: string,
    relation: import('../../protocol/src/manager-posts.mjs').ManagerRelation,
  ): void {
    this.db
      .prepare(
        'INSERT INTO manager_relations VALUES(?,?,?) ON CONFLICT(manager_id,id) DO UPDATE SET body=excluded.body',
      )
      .run(managerId, relation.id, JSON.stringify(relation))
  }
  publishedReports(
    managerId: string,
  ): import('../../protocol/src/manager-posts.mjs').ManagerReport[] {
    return this.db
      .prepare('SELECT body FROM manager_reports WHERE manager_id=? ORDER BY rowid')
      .all(managerId)
      .map((row) => JSON.parse(String(row.body)))
  }
  publishedReport(
    managerId: string,
    id: string,
  ): import('../../protocol/src/manager-posts.mjs').ManagerReport | null {
    return body(
      this.db
        .prepare('SELECT body FROM manager_reports WHERE manager_id=? AND id=?')
        .get(managerId, id),
    )
  }
  savePublishedReport(
    managerId: string,
    report: import('../../protocol/src/manager-posts.mjs').ManagerReport,
  ): void {
    this.db
      .prepare(
        'INSERT INTO manager_reports VALUES(?,?,?) ON CONFLICT(manager_id,id) DO UPDATE SET body=excluded.body',
      )
      .run(managerId, report.id, JSON.stringify(report))
  }
  suggestionVersion(managerId: string, id: string): { revision: number; updatedAt: number } | null {
    return body(
      this.db
        .prepare('SELECT body FROM manager_suggestion_versions WHERE manager_id=? AND id=?')
        .get(managerId, id),
    )
  }
  saveSuggestionVersion(managerId: string, id: string, revision: number): void {
    this.db
      .prepare(
        'INSERT INTO manager_suggestion_versions VALUES(?,?,?) ON CONFLICT(manager_id,id) DO UPDATE SET body=excluded.body',
      )
      .run(managerId, id, JSON.stringify({ revision, updatedAt: managerNow() }))
  }
  questions(managerId?: string): QuestionState[] {
    return this.db
      .prepare(`SELECT body FROM questions ${managerId ? 'WHERE manager_id=?' : ''}`)
      .all(...(managerId ? [managerId] : []))
      .map((row) => body<QuestionState>(row) as QuestionState)
  }
  question(managerId: string, decisionId: string): QuestionState | null {
    return body(
      this.db
        .prepare('SELECT body FROM questions WHERE manager_id=? AND decision_id=?')
        .get(managerId, decisionId),
    )
  }
  saveQuestion(state: QuestionState): void {
    this.db
      .prepare(
        'INSERT INTO questions VALUES(?,?,?) ON CONFLICT(manager_id,decision_id) DO UPDATE SET body=excluded.body',
      )
      .run(state.managerId, state.decisionId, JSON.stringify(state))
  }
  nextId(managerId: string, kind: 'D' | 'I' | 'R' | 'P'): ManagerObjectId {
    const row = this.db
      .prepare(
        'INSERT INTO counters VALUES(?,?,1) ON CONFLICT(manager_id,kind) DO UPDATE SET value=value+1 RETURNING value',
      )
      .get(managerId, kind)
    return `${kind}-${Number(row?.value)}`
  }
  situation(managerId: string): ManagerSituation | null {
    return body(this.db.prepare('SELECT body FROM situations WHERE manager_id=?').get(managerId))
  }
  saveSituation(managerId: string, situation: ManagerSituation): void {
    this.db
      .prepare(
        'INSERT INTO situations VALUES(?,?) ON CONFLICT(manager_id) DO UPDATE SET body=excluded.body',
      )
      .run(managerId, JSON.stringify(situation))
  }
  changes(managerId: string): ManagerChange[] {
    return this.db
      .prepare('SELECT body FROM changes WHERE manager_id=? ORDER BY seq DESC')
      .all(managerId)
      .map((row) => body<ManagerChange>(row) as ManagerChange)
  }
  record(
    managerId: string,
    objectId: ManagerChange['objectId'],
    by: ManagerActor,
    before: object | null,
    after: object | null,
    why: string,
  ): void {
    const previous = before as Record<string, unknown> | null
    const next = after as Record<string, unknown> | null
    const fields = [
      ...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]),
    ].filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]))
    const change: ManagerChange = {
      id: randomUUID(),
      objectId,
      by,
      at: managerNow(),
      fields,
      before: previous,
      after: next,
      why,
    }
    this.db
      .prepare('INSERT INTO changes(manager_id,body) VALUES(?,?)')
      .run(managerId, JSON.stringify(change))
  }
  enqueue(managerId: string, text: string): string {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO deliveries(id,manager_id,text) VALUES(?,?,?)')
      .run(id, managerId, text)
    return id
  }
  deliveries(managerId?: string): ManagerDelivery[] {
    return this.db
      .prepare(`SELECT * FROM deliveries ${managerId ? 'WHERE manager_id=?' : ''} ORDER BY seq`)
      .all(...(managerId ? [managerId] : []))
      .map((row) => ({
        id: String(row.id),
        managerId: String(row.manager_id),
        text: String(row.text),
      }))
  }
  delivered(id: string): void {
    this.db.prepare('DELETE FROM deliveries WHERE id=?').run(id)
  }
  report(threadId: string): LineReport | null {
    return body(this.db.prepare('SELECT body FROM reports WHERE thread_id=?').get(threadId))
  }
  saveReport(threadId: string, report: LineReport): void {
    this.db
      .prepare(
        'INSERT INTO reports VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body',
      )
      .run(threadId, JSON.stringify(report))
  }
  beginEnding(managerId: string, eventId: string, text: string): void {
    this.db.prepare('INSERT INTO endings VALUES(?,?,?,NULL)').run(managerId, eventId, text)
  }
  ending(managerId: string): ManagerEnding | null {
    const row = this.db.prepare('SELECT * FROM endings WHERE manager_id=?').get(managerId)
    return row
      ? {
          eventId: String(row.event_id),
          text: String(row.text),
          turnId: row.turn_id === null ? null : String(row.turn_id),
        }
      : null
  }
  setEndingTurn(managerId: string, turnId: string): void {
    this.db.prepare('UPDATE endings SET turn_id=? WHERE manager_id=?').run(turnId, managerId)
  }
  close(): void {
    this.db.close()
  }
}
