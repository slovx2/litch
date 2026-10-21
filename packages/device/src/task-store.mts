// 定时任务的库（<状态目录>/device/tasks.sqlite）：任务和它们的运行记录。
// 和设备库 device.sqlite 不同，这里的东西删了就没了（用户建的任务），所以带迁移：
// 结构变了往 MIGRATIONS 末尾加一步，旧库按顺序升上来，绝不整库重建。
// 权限和预写日志的写法照设备库（store.mts）。
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  DeviceTaskRun,
  TaskError,
  TaskOrigin,
  TaskRunStatus,
  TaskSchedule,
  TaskStatus,
  TaskTarget,
} from '../../protocol/src/device-tasks.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

/**
 * 迁移，第 n 项把 user_version 从 n 升到 n+1。只往后加，已经发出去的不改：
 * 用户机器上的库是按它们一步一步升上来的。
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE tasks(
     id TEXT PRIMARY KEY,
     -- 建的先后，列表按它排
     seq INTEGER NOT NULL,
     name TEXT NOT NULL,
     prompt TEXT NOT NULL,
     schedule TEXT NOT NULL,
     timezone TEXT NOT NULL,
     status TEXT NOT NULL,
     target TEXT NOT NULL,
     origin TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     -- 日程从什么时候起算（建好或者日程改好的时间），见 task-schedule.mts 的 anchor
     anchor INTEGER NOT NULL,
     next_run_at INTEGER,
     last_run_at INTEGER,
     last_error TEXT,
     -- 上一次还没结束时到了的时间点，记到下一次运行的 coalesced 里
     pending_coalesced INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE runs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     task_id TEXT NOT NULL,
     trigger TEXT NOT NULL,
     -- 按日程的运行：任务、revision、时间点。同一个时间点只跑一次，设备进程重启也不再跑。手动的是 null
     trigger_key TEXT UNIQUE,
     scheduled_for INTEGER NOT NULL,
     coalesced INTEGER NOT NULL,
     status TEXT NOT NULL,
     harness TEXT NOT NULL,
     thread_id TEXT,
     turn_id TEXT,
     started_at INTEGER,
     finished_at INTEGER,
     summary TEXT,
     error TEXT,
     read INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX runs_by_task ON runs(task_id, seq);
   CREATE INDEX runs_by_status ON runs(status);`,
  // 回合结束时会话里还有几个后台任务在跑（backgroundTasks 扩展）。旧的运行记成 0
  `ALTER TABLE runs ADD COLUMN background INTEGER NOT NULL DEFAULT 0;`,
]

/** 现在的结构版本 */
export const TASK_SCHEMA_VERSION = MIGRATIONS.length

/** 每个任务留最近这么多条运行记录 */
export const TASK_RUNS_KEPT = 200

/** 库里的一个任务。比协议里的对象少了跟着运行算出来的那几项，多了排日程要用的 */
export interface TaskRow {
  id: string
  seq: number
  name: string
  prompt: string
  schedule: TaskSchedule
  timezone: string
  status: TaskStatus
  target: TaskTarget
  origin: TaskOrigin
  revision: number
  createdAt: number
  updatedAt: number
  anchor: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastError: TaskError | null
  pendingCoalesced: number
}

/** 库里的一次运行：协议里的对象加上排序号和触发键 */
export interface RunRow extends DeviceTaskRun {
  seq: number
  triggerKey: string | null
}

const FINISHED: readonly TaskRunStatus[] = ['succeeded', 'failed', 'canceled']
export const isFinished = (status: TaskRunStatus): boolean => FINISHED.includes(status)

const json = (value: unknown): string | null => (value == null ? null : JSON.stringify(value))
const parsed = <T,>(value: unknown): T | null =>
  typeof value === 'string' ? (JSON.parse(value) as T) : null
const integer = (value: unknown): number | null => (value == null ? null : Number(value))
const text = (value: unknown): string | null => (value == null ? null : String(value))

function taskOf(row: Record<string, SQLInputValue>): TaskRow {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: parsed<TaskSchedule>(row.schedule) as TaskSchedule,
    timezone: String(row.timezone),
    status: String(row.status) as TaskStatus,
    target: parsed<TaskTarget>(row.target) as TaskTarget,
    origin: parsed<TaskOrigin>(row.origin) as TaskOrigin,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    anchor: Number(row.anchor),
    nextRunAt: integer(row.next_run_at),
    lastRunAt: integer(row.last_run_at),
    lastError: parsed<TaskError>(row.last_error),
    pendingCoalesced: Number(row.pending_coalesced),
  }
}

function runOf(row: Record<string, SQLInputValue>): RunRow {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    taskId: String(row.task_id),
    trigger: String(row.trigger) as DeviceTaskRun['trigger'],
    triggerKey: text(row.trigger_key),
    scheduledFor: Number(row.scheduled_for),
    coalesced: Number(row.coalesced),
    status: String(row.status) as TaskRunStatus,
    harness: String(row.harness),
    threadId: text(row.thread_id),
    turnId: text(row.turn_id),
    startedAt: integer(row.started_at),
    finishedAt: integer(row.finished_at),
    summary: text(row.summary),
    error: parsed<TaskError>(row.error),
    read: row.read === 1,
    ...(Number(row.background) > 0 ? { backgroundTasks: Number(row.background) } : {}),
  }
}

/** 协议里的运行对象：去掉库里自己用的两项 */
export function publicRun(run: RunRow): DeviceTaskRun {
  const { seq: _seq, triggerKey: _key, ...rest } = run
  return rest
}

/** 打开（或者新建、升级）任务库。库比这一版的结构新（用过更新的版本）时抛错，不碰它 */
export function openTaskDatabase(stateDir: string): DatabaseSync {
  const path = join(stateDir, 'tasks.sqlite')
  ensureParent(path)
  if (existsSync(path) && statSync(path).size > 0) assertStoreFormat(path)
  // 先把文件建出来再打开：预写日志等附带的文件会沿用主文件的权限（只有属主可读写）
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  try {
    initializeStoreFormat(db)
    db.exec('PRAGMA journal_mode=WAL')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > TASK_SCHEMA_VERSION)
      throw new Error(
        `任务库的结构版本是 ${version}，比这一版认识的 ${TASK_SCHEMA_VERSION} 新：用过更新的版本，这一版不碰它`,
      )
    for (let step = version; step < TASK_SCHEMA_VERSION; step++) {
      db.exec('BEGIN')
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

export interface RunFilter {
  taskId: string | null
  limit: number
  /** 只要排序号比它小的（更早的） */
  before: number | null
}

export class TaskStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  /** 一组改动要么都成要么都不成 */
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

  // ---------- 任务 ----------

  tasks(): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY seq')
      .all()
      .map((row) => taskOf(row))
  }

  task(id: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
    return row ? taskOf(row) : null
  }

  count(): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n ?? 0)
  }

  nextSeq(): number {
    return Number(this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM tasks').get()?.n)
  }

  /** 新建或者整个换掉 */
  saveTask(task: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks(id, seq, name, prompt, schedule, timezone, status, target, origin, revision,
           created_at, updated_at, anchor, next_run_at, last_run_at, last_error, pending_coalesced)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, name=excluded.name, prompt=excluded.prompt,
           schedule=excluded.schedule, timezone=excluded.timezone, status=excluded.status,
           target=excluded.target, origin=excluded.origin, revision=excluded.revision,
           created_at=excluded.created_at, updated_at=excluded.updated_at, anchor=excluded.anchor,
           next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at,
           last_error=excluded.last_error, pending_coalesced=excluded.pending_coalesced`,
      )
      .run(
        task.id,
        task.seq,
        task.name,
        task.prompt,
        JSON.stringify(task.schedule),
        task.timezone,
        task.status,
        JSON.stringify(task.target),
        JSON.stringify(task.origin),
        task.revision,
        task.createdAt,
        task.updatedAt,
        task.anchor,
        task.nextRunAt,
        task.lastRunAt,
        json(task.lastError),
        task.pendingCoalesced,
      )
  }

  /** 删掉任务和它的运行记录 */
  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE task_id=?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id)
  }

  // ---------- 运行 ----------

  /** 记一次运行。触发键已经用过（这个时间点跑过了）返回 false，什么都不写 */
  insertRun(run: DeviceTaskRun, triggerKey: string | null): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO runs(id, task_id, trigger, trigger_key, scheduled_for, coalesced, status,
           harness, thread_id, turn_id, started_at, finished_at, summary, error, read)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.trigger,
        triggerKey,
        run.scheduledFor,
        run.coalesced,
        run.status,
        run.harness,
        run.threadId,
        run.turnId,
        run.startedAt,
        run.finishedAt,
        run.summary,
        json(run.error),
        run.read ? 1 : 0,
      )
    return Number(result.changes) > 0
  }

  /** 改一次运行的状态和结果。运行已经随任务删掉了返回 false */
  updateRun(run: DeviceTaskRun): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET status=?, thread_id=?, turn_id=?, started_at=?, finished_at=?, summary=?,
           error=?, read=?, background=? WHERE id=?`,
      )
      .run(
        run.status,
        run.threadId,
        run.turnId,
        run.startedAt,
        run.finishedAt,
        run.summary,
        json(run.error),
        run.read ? 1 : 0,
        run.backgroundTasks ?? 0,
        run.id,
      )
    return Number(result.changes) > 0
  }

  run(id: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    return row ? runOf(row) : null
  }

  /** 这个任务最近的一次运行 */
  lastRun(taskId: string): RunRow | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE task_id=? ORDER BY seq DESC LIMIT 1')
      .get(taskId)
    return row ? runOf(row) : null
  }

  /** 这个任务还没结束的那一次（queued 或 running） */
  activeRun(taskId: string): RunRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE task_id=? AND status IN ('queued', 'running') ORDER BY seq LIMIT 1`,
      )
      .get(taskId)
    return row ? runOf(row) : null
  }

  /** 某几种状态的全部运行，按排序号 */
  runsIn(statuses: readonly TaskRunStatus[]): RunRow[] {
    const marks = statuses.map(() => '?').join(', ')
    return this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${marks}) ORDER BY seq`)
      .all(...statuses)
      .map((row) => runOf(row))
  }

  unread(taskId: string): number {
    return Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM runs WHERE task_id=? AND read=0
             AND status IN ('succeeded', 'failed', 'canceled')`,
        )
        .get(taskId)?.n ?? 0,
    )
  }

  /** 新的在前 */
  runs(filter: RunFilter): RunRow[] {
    const where: string[] = []
    const args: SQLInputValue[] = []
    if (filter.taskId !== null) {
      where.push('task_id=?')
      args.push(filter.taskId)
    }
    if (filter.before !== null) {
      where.push('seq<?')
      args.push(filter.before)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM runs ${clause} ORDER BY seq DESC LIMIT ?`)
      .all(...args, filter.limit)
      .map((row) => runOf(row))
  }

  /** 标成看过：返回真的从没看过变成看过的那几条 */
  markRead(taskId: string | null, runIds: readonly string[] | null): RunRow[] {
    const where = [`read=0`, `status IN ('succeeded', 'failed', 'canceled')`]
    const args: SQLInputValue[] = []
    if (runIds !== null) {
      if (runIds.length === 0) return []
      where.push(`id IN (${runIds.map(() => '?').join(', ')})`)
      args.push(...runIds)
    } else if (taskId !== null) {
      where.push('task_id=?')
      args.push(taskId)
    }
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY seq`)
      .all(...args)
      .map((row) => runOf(row))
    const mark = this.db.prepare('UPDATE runs SET read=1 WHERE id=?')
    for (const row of rows) {
      mark.run(row.id)
      row.read = true
    }
    return rows
  }

  /** 这个任务的运行记录只留最近 TASK_RUNS_KEPT 条（还没结束的不删） */
  prune(taskId: string): void {
    this.db
      .prepare(
        `DELETE FROM runs WHERE task_id=? AND status IN ('succeeded', 'failed', 'canceled') AND seq < (
           SELECT min(seq) FROM (SELECT seq FROM runs WHERE task_id=? ORDER BY seq DESC LIMIT ?))`,
      )
      .run(taskId, taskId, TASK_RUNS_KEPT)
  }
}
