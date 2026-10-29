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
] as const
export const MANAGER_SCHEMA_VERSION = MIGRATIONS.length
export const managerNow = () => Math.floor(Date.now() / 1000)
export type BoardObject = ManagerDecision | ManagerItem
export interface ManagerDelivery {
  id: string
  managerId: string
  text: string
}
export interface LineReport {
  text: string
  at: number
  turnId: string
  status: string
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
  nextId(managerId: string, kind: 'D' | 'I'): ManagerObjectId {
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
  enqueue(managerId: string, text: string): void {
    this.db
      .prepare('INSERT INTO deliveries(id,manager_id,text) VALUES(?,?,?)')
      .run(randomUUID(), managerId, text)
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
  close(): void {
    this.db.close()
  }
}
