// 会话树的库（<设备状态目录>/sessions.sqlite）：子会话的父子关系、提案、回报队列、唤醒计数。
// 和设备库 device.sqlite 不同，这里的东西删了就找不回来（父子关系不存在任何引擎里），所以带迁移：
// 结构变了往 MIGRATIONS 末尾加一步，旧库按顺序升上来，绝不整库重建（做法同定时任务的 tasks.sqlite）。
// 权限和预写日志的写法照设备库（store.mts）。
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  SessionEventNote,
  SessionLineage,
  SessionLineageKind,
  SessionLineageOrigin,
  SessionProposal,
  SessionProposalStatus,
} from '../../protocol/src/session-tree.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

/**
 * 迁移，第 n 项把 user_version 从 n 升到 n+1。只往后加，已经发出去的不改：
 * 用户机器上的库是按它们一步一步升上来的。
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE lineage(
     thread_id TEXT PRIMARY KEY,
     parent_thread_id TEXT NOT NULL,
     harness TEXT NOT NULL,
     kind TEXT NOT NULL,
     origin TEXT NOT NULL,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     wake_parent INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     -- 脱离成独立会话的时间。不是 null 就不算子会话了（记录留着，不再显示、不再回报）
     detached_at INTEGER,
     -- 最近一个已经进了回报队列的回合，同一个回合不报两次
     reported_turn TEXT
   ) WITHOUT ROWID;
   CREATE INDEX lineage_by_parent ON lineage(parent_thread_id);
   CREATE TABLE proposals(
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     harness TEXT,
     model TEXT,
     cwd TEXT,
     kind TEXT NOT NULL,
     wake_parent INTEGER NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     started_thread_id TEXT
   );
   CREATE INDEX proposals_by_thread ON proposals(thread_id, status);
   CREATE TABLE notes(
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     parent_thread_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     excerpt TEXT NOT NULL,
     -- 派这个子会话时要不要唤醒父会话（进队列那一刻的）
     wake INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX notes_by_parent ON notes(parent_thread_id, seq);
   -- 上一条用户消息之后替这个会话开过几个唤醒回合
   CREATE TABLE wakes(
     thread_id TEXT PRIMARY KEY,
     count INTEGER NOT NULL
   ) WITHOUT ROWID;
   -- 客户端建会话时带的动态工具（thread/start.dynamicTools）：设备进程替它派子会话时照样带给子会话
   CREATE TABLE thread_tools(
     thread_id TEXT PRIMARY KEY,
     tools TEXT NOT NULL
   ) WITHOUT ROWID;`,
]

export const SESSION_SCHEMA_VERSION = MIGRATIONS.length

/** 库里的一条父子关系 */
export interface LineageRow extends SessionLineage {
  threadId: string
  /** 子会话所在的 harness */
  harness: string
  prompt: string
  detachedAt: number | null
  reportedTurn: string | null
}

/** 队列里的一条回报 */
export interface QueuedNote extends SessionEventNote {
  seq: number
  /** 派这个子会话时说了要唤醒父会话 */
  wake: boolean
}

const now = () => Math.floor(Date.now() / 1000)

function upgrade(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > MIGRATIONS.length)
    throw new Error(
      `会话树的库是更新的版本（${version}）建的，这一版设备服务只认到 ${MIGRATIONS.length}`,
    )
  for (let step = version; step < MIGRATIONS.length; step++) {
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
}

export function openSessionDatabase(stateDir: string): DatabaseSync {
  const path = join(stateDir, 'sessions.sqlite')
  ensureParent(path)
  if (existsSync(path) && statSync(path).size > 0) assertStoreFormat(path)
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  initializeStoreFormat(db)
  db.exec('PRAGMA journal_mode=WAL')
  upgrade(db)
  return db
}

type Row = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const maybe = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function lineageOf(row: Row): LineageRow {
  return {
    threadId: text(row.thread_id),
    parentThreadId: text(row.parent_thread_id),
    harness: text(row.harness),
    kind: text(row.kind) as SessionLineageKind,
    origin: text(row.origin) as SessionLineageOrigin,
    title: text(row.title),
    prompt: text(row.prompt),
    wakeParent: row.wake_parent === 1,
    createdAt: Number(row.created_at),
    detachedAt: row.detached_at == null ? null : Number(row.detached_at),
    reportedTurn: maybe(row.reported_turn),
  }
}

function proposalOf(row: Row): SessionProposal {
  return {
    id: text(row.id),
    threadId: text(row.thread_id),
    title: text(row.title),
    prompt: text(row.prompt),
    harness: maybe(row.harness),
    model: maybe(row.model),
    cwd: maybe(row.cwd),
    kind: text(row.kind) as SessionLineageKind,
    wakeParent: row.wake_parent === 1,
    status: text(row.status) as SessionProposalStatus,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    startedThreadId: maybe(row.started_thread_id),
  }
}

/** 父子关系常驻内存（聚合面给每个会话对象挂 litchLineage 时要查），写的时候同时落库 */
export class SessionStore {
  private readonly db: DatabaseSync
  private readonly lineage = new Map<string, LineageRow>()
  private readonly statements: Record<string, StatementSync>

  constructor(db: DatabaseSync) {
    this.db = db
    for (const row of db.prepare('SELECT * FROM lineage').all())
      this.lineage.set(text(row.thread_id), lineageOf(row))
    const prepare = (sql: string) => db.prepare(sql)
    this.statements = {
      addLineage: prepare(
        `INSERT INTO lineage(thread_id, parent_thread_id, harness, kind, origin, title, prompt, wake_parent, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      detach: prepare('UPDATE lineage SET detached_at=? WHERE thread_id=?'),
      reported: prepare('UPDATE lineage SET reported_turn=? WHERE thread_id=?'),
      addProposal: prepare(
        `INSERT INTO proposals(id, thread_id, title, prompt, harness, model, cwd, kind, wake_parent, status, created_at, expires_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ),
      proposal: prepare('SELECT * FROM proposals WHERE id=?'),
      pending: prepare(
        "SELECT * FROM proposals WHERE thread_id=? AND status='pending' ORDER BY created_at, rowid",
      ),
      expiring: prepare("SELECT * FROM proposals WHERE status='pending' AND expires_at<=?"),
      settleProposal: prepare(
        "UPDATE proposals SET status=?, started_thread_id=? WHERE id=? AND status='pending'",
      ),
      nextExpiry: prepare("SELECT MIN(expires_at) AS at FROM proposals WHERE status='pending'"),
      addNote: prepare(
        `INSERT INTO notes(parent_thread_id, thread_id, title, status, excerpt, wake, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ),
      notes: prepare('SELECT * FROM notes WHERE parent_thread_id=? ORDER BY seq'),
      noteParents: prepare('SELECT DISTINCT parent_thread_id FROM notes'),
      dropNotes: prepare('DELETE FROM notes WHERE parent_thread_id=? AND seq<=?'),
      wakes: prepare('SELECT count FROM wakes WHERE thread_id=?'),
      setWakes: prepare(
        'INSERT INTO wakes(thread_id, count) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET count=excluded.count',
      ),
      tools: prepare('SELECT tools FROM thread_tools WHERE thread_id=?'),
      setTools: prepare(
        'INSERT INTO thread_tools(thread_id, tools) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET tools=excluded.tools',
      ),
    }
  }

  private run(name: string, ...values: (string | number | null)[]): void {
    this.statements[name]?.run(...values)
  }

  // ---------- 父子关系 ----------

  /** 还没脱离的父子关系。没有是 null */
  parentOf(threadId: string): LineageRow | null {
    const row = this.lineage.get(threadId)
    return row && row.detachedAt === null ? row : null
  }

  /** 直接子女（没脱离的），按建立的先后 */
  childrenOf(threadId: string): LineageRow[] {
    return [...this.lineage.values()]
      .filter((row) => row.parentThreadId === threadId && row.detachedAt === null)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 是不是 ancestor 的 Litch 子孙（没脱离的那几层） */
  descends(threadId: string, ancestor: string): boolean {
    const seen = new Set<string>()
    let current = this.parentOf(threadId)
    while (current && !seen.has(current.threadId)) {
      if (current.parentThreadId === ancestor) return true
      seen.add(current.threadId)
      current = this.parentOf(current.parentThreadId)
    }
    return false
  }

  /** 全部子孙（没脱离的），广度优先 */
  descendants(threadId: string): LineageRow[] {
    const found: LineageRow[] = []
    const queue = [threadId]
    const seen = new Set(queue)
    while (queue.length) {
      for (const child of this.childrenOf(queue.shift() as string)) {
        if (seen.has(child.threadId)) continue
        seen.add(child.threadId)
        found.push(child)
        queue.push(child.threadId)
      }
    }
    return found
  }

  /** 有子会话、或者有回报没交出去的会话：设备进程要盯着它们 */
  parents(): string[] {
    const set = new Set<string>()
    for (const row of this.lineage.values())
      if (row.detachedAt === null) set.add(row.parentThreadId)
    return [...set]
  }

  /** 全部没脱离的子会话 */
  children(): LineageRow[] {
    return [...this.lineage.values()].filter((row) => row.detachedAt === null)
  }

  addLineage(row: Omit<LineageRow, 'detachedAt' | 'reportedTurn'>): LineageRow {
    const full: LineageRow = { ...row, detachedAt: null, reportedTurn: null }
    // 同一个会话再派一次（脱离之后又被派）：旧的那条换掉
    this.db.prepare('DELETE FROM lineage WHERE thread_id=?').run(row.threadId)
    this.run(
      'addLineage',
      row.threadId,
      row.parentThreadId,
      row.harness,
      row.kind,
      row.origin,
      row.title,
      row.prompt,
      row.wakeParent ? 1 : 0,
      row.createdAt,
    )
    this.lineage.set(row.threadId, full)
    return full
  }

  /** 脱离：返回原来的那条（没有、已经脱离过是 null） */
  detach(threadId: string): LineageRow | null {
    const row = this.parentOf(threadId)
    if (!row) return null
    row.detachedAt = now()
    this.run('detach', row.detachedAt, threadId)
    return row
  }

  /** 这个回合报过了没有；没报过就记上，返回 true */
  markReported(threadId: string, turnId: string): boolean {
    const row = this.parentOf(threadId)
    if (!row || row.reportedTurn === turnId) return false
    row.reportedTurn = turnId
    this.run('reported', turnId, threadId)
    return true
  }

  // ---------- 提案 ----------

  addProposal(proposal: Omit<SessionProposal, 'status' | 'startedThreadId'>): SessionProposal {
    this.run(
      'addProposal',
      proposal.id,
      proposal.threadId,
      proposal.title,
      proposal.prompt,
      proposal.harness,
      proposal.model,
      proposal.cwd,
      proposal.kind,
      proposal.wakeParent ? 1 : 0,
      proposal.createdAt,
      proposal.expiresAt,
    )
    return { ...proposal, status: 'pending', startedThreadId: null }
  }

  proposal(id: string): SessionProposal | null {
    const row = this.statements.proposal?.get(id)
    return row ? proposalOf(row) : null
  }

  pending(threadId: string): SessionProposal[] {
    return (this.statements.pending?.all(threadId) ?? []).map(proposalOf)
  }

  /** 把一个 pending 的提案改成别的状态。已经不是 pending 了返回 false */
  settleProposal(
    id: string,
    status: SessionProposalStatus,
    startedThreadId: string | null,
  ): boolean {
    const result = this.statements.settleProposal?.run(status, startedThreadId, id)
    return Number(result?.changes ?? 0) > 0
  }

  /** 到点了还 pending 的提案 */
  expiring(at: number): SessionProposal[] {
    return (this.statements.expiring?.all(at) ?? []).map(proposalOf)
  }

  /** 最早到期的那个 pending 提案的时间（秒）。没有是 null */
  nextExpiry(): number | null {
    const at = this.statements.nextExpiry?.get()?.at
    return at == null ? null : Number(at)
  }

  // ---------- 回报队列 ----------

  addNote(parentThreadId: string, note: SessionEventNote, wake: boolean): void {
    this.run(
      'addNote',
      parentThreadId,
      note.threadId,
      note.title,
      note.status,
      note.excerpt,
      wake ? 1 : 0,
      now(),
    )
  }

  notes(parentThreadId: string): QueuedNote[] {
    return (this.statements.notes?.all(parentThreadId) ?? []).map((row) => ({
      seq: Number(row.seq),
      threadId: text(row.thread_id),
      title: text(row.title),
      status: text(row.status) as SessionEventNote['status'],
      excerpt: text(row.excerpt),
      wake: row.wake === 1,
    }))
  }

  /** 有回报在排队的会话 */
  noteParents(): string[] {
    return (this.statements.noteParents?.all() ?? []).map((row) => text(row.parent_thread_id))
  }

  /** 交出去了：到 seq 为止的都删掉 */
  dropNotes(parentThreadId: string, seq: number): void {
    this.run('dropNotes', parentThreadId, seq)
  }

  // ---------- 唤醒计数 ----------

  wakes(threadId: string): number {
    return Number(this.statements.wakes?.get(threadId)?.count ?? 0)
  }

  setWakes(threadId: string, count: number): void {
    this.run('setWakes', threadId, count)
  }

  // ---------- 会话带的动态工具 ----------

  tools(threadId: string): unknown[] | null {
    const raw = this.statements.tools?.get(threadId)?.tools
    if (typeof raw !== 'string') return null
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  setTools(threadId: string, tools: unknown[]): void {
    this.run('setTools', threadId, JSON.stringify(tools))
  }
}
