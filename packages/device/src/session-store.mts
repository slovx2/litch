// 会话树的库（<设备状态目录>/sessions.sqlite）：子会话的父子关系、提案、回报队列、唤醒计数。
// 和设备库 device.sqlite 不同，这里的东西删了就找不回来（父子关系不存在任何引擎里），所以带迁移：
// 结构变了往 MIGRATIONS 末尾加一步，旧库按顺序升上来，绝不整库重建（做法同定时任务的 tasks.sqlite）。
// 权限和预写日志的写法照设备库（store.mts）。
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { SessionDelegatedResponse } from '../../protocol/src/session-pending.mjs'
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
import type { ThreadInstructions } from './codex-instructions.mjs'

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
  // 从提案开始的子会话记下是哪个提案（已经开始过的按提案上记的子会话补上）；
  // 提案记下目标 harness 收不紧时子会话实际的沙箱
  `ALTER TABLE lineage ADD COLUMN proposal_id TEXT;
   UPDATE lineage SET proposal_id =
     (SELECT id FROM proposals WHERE proposals.started_thread_id = lineage.thread_id LIMIT 1);
   ALTER TABLE proposals ADD COLUMN wider_sandbox TEXT;`,
  // 提案记下了结的时间、在父会话的哪个回合哪次工具调用里提的（对话流里的卡片画在那一条上）。
  // 旧的已过期提案按到期时间补上了结时间，开始、不要的旧提案不知道是什么时候，留空
  `ALTER TABLE proposals ADD COLUMN settled_at INTEGER;
   ALTER TABLE proposals ADD COLUMN turn_id TEXT;
   ALTER TABLE proposals ADD COLUMN call_id TEXT;
   UPDATE proposals SET settled_at = expires_at WHERE status = 'expired';`,
  // 原生 codex 不保存开发者指令：建会话、分叉时记下客户端给的那段（没给是 null）、带规则的命名空间（JSON）和目录，
  // 恢复、分叉时设备进程照着补（codex-instructions.mts）
  `CREATE TABLE thread_instructions(
     thread_id TEXT PRIMARY KEY,
     given TEXT,
     namespaces TEXT NOT NULL,
     cwd TEXT
   ) WITHOUT ROWID;`,
  // offer 卡（litch_sessions.start 的 initiation offer）：只带标题出“新会话 / 在这里做”的卡，状态从 offered 起
  `ALTER TABLE proposals ADD COLUMN offer INTEGER NOT NULL DEFAULT 0;`,
  // 提案的背景（litch_sessions 的 background）和任务（prompt）分开存，开始时分两段交给子会话。旧提案没有背景
  `ALTER TABLE proposals ADD COLUMN background TEXT NOT NULL DEFAULT '';`,
  // Litch 自己替某个 harness 做的功能的开关（不在 harness 原生配置里的，比如原生 codex 的自动起名，codex-titles.mts）。
  // 值是 JSON，没写过的行不存在、按默认
  `CREATE TABLE harness_options(
     harness TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY(harness, key)
   ) WITHOUT ROWID;`,
  // 回报记下子会话那一回合结束时还有几个后台任务在跑（backgroundTasks 扩展）。旧的回报记成 0
  `ALTER TABLE notes ADD COLUMN background INTEGER NOT NULL DEFAULT 0;`,
  // 提案的推理强度（start、wrap_up 的建议可带 effort）。不写是 null，开始时取父会话那一刻的；旧提案都是 null
  `ALTER TABLE proposals ADD COLUMN effort TEXT;`,
  // 回报记下回合失败、被打断时的错误原文，和子会话是不是用户亲手停下的（interrupted、archived）。旧的回报都是 null
  `ALTER TABLE notes ADD COLUMN error TEXT;
   ALTER TABLE notes ADD COLUMN user_stopped TEXT;`,
  // 只做一次的整理，做完删掉那一行。pruneThreadTools：以前删会话时没删它带的动态工具，留下的行清一次（device.mts）
  `CREATE TABLE chores(name TEXT PRIMARY KEY) WITHOUT ROWID;
   INSERT INTO chores(name) VALUES('pruneThreadTools');`,
  // 提案上子会话要不要自己的工作树（worktrees 扩展）：模型或用户定的（null 是没定），和没定时照缺省算出来的
  `ALTER TABLE proposals ADD COLUMN worktree INTEGER;
   ALTER TABLE proposals ADD COLUMN worktree_default INTEGER NOT NULL DEFAULT 0;`,
  // 原生 codex 不保存速度（serviceTier）：客户端选过的记下来，恢复、分叉没带时设备进程补回（codex-speeds.mts）
  `CREATE TABLE thread_speeds(
     thread_id TEXT PRIMARY KEY,
     speed TEXT NOT NULL
   ) WITHOUT ROWID;`,
  // 用户在一个会话里 @ 过另一个会话：这两个会话之间可以互相发消息（litch_sessions.send），不论有没有父子关系
  `CREATE TABLE mentions(
     thread_id TEXT NOT NULL,
     mentioned_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY(thread_id, mentioned_id)
   ) WITHOUT ROWID;
   CREATE INDEX mentions_by_target ON mentions(mentioned_id);`,
  // 两个会话之间发过消息（任何一方向另一方：litch_sessions.send、打断、用户 @、派子会话……）：之后一直可以互相发消息。
  // 一对不分方向，a 是字典序小的那个。以前记的 @、派出的子会话都算发过
  `CREATE TABLE contacts(
     a TEXT NOT NULL,
     b TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY(a, b)
   ) WITHOUT ROWID;
   CREATE INDEX contacts_by_b ON contacts(b);
   INSERT OR IGNORE INTO contacts(a, b, created_at)
     SELECT min(thread_id, mentioned_id), max(thread_id, mentioned_id), created_at FROM mentions;
   INSERT OR IGNORE INTO contacts(a, b, created_at)
     SELECT min(thread_id, parent_thread_id), max(thread_id, parent_thread_id), created_at FROM lineage;
   DROP TABLE mentions;`,
  `CREATE TABLE delegated_responses(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, record TEXT NOT NULL);
   CREATE INDEX delegated_by_thread ON delegated_responses(thread_id);`,
]

export const SESSION_SCHEMA_VERSION = MIGRATIONS.length

/** 测试里造旧版本的库用 */
export const SESSION_MIGRATIONS = MIGRATIONS

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
  /** 进队列的时间（秒） */
  at: number
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
    ...(typeof row.proposal_id === 'string' ? { proposalId: row.proposal_id } : {}),
  }
}

function proposalOf(row: Row): SessionProposal {
  return {
    id: text(row.id),
    threadId: text(row.thread_id),
    title: text(row.title),
    prompt: text(row.prompt),
    background: text(row.background),
    harness: maybe(row.harness),
    model: maybe(row.model),
    effort: maybe(row.effort),
    cwd: maybe(row.cwd),
    kind: text(row.kind) as SessionLineageKind,
    wakeParent: row.wake_parent === 1,
    status: text(row.status) as SessionProposalStatus,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    startedThreadId: maybe(row.started_thread_id),
    settledAt: row.settled_at == null ? null : Number(row.settled_at),
    turnId: maybe(row.turn_id),
    callId: maybe(row.call_id),
    ...(typeof row.wider_sandbox === 'string' ? { widerSandbox: row.wider_sandbox } : {}),
    ...(row.offer === 1 ? { offer: true } : {}),
    worktree: row.worktree == null ? null : row.worktree === 1,
    worktreeDefault: row.worktree_default === 1,
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
        `INSERT INTO lineage(thread_id, parent_thread_id, harness, kind, origin, title, prompt, wake_parent, created_at, proposal_id)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      detach: prepare('UPDATE lineage SET detached_at=? WHERE thread_id=?'),
      reported: prepare('UPDATE lineage SET reported_turn=? WHERE thread_id=?'),
      addProposal: prepare(
        `INSERT INTO proposals(id, thread_id, title, prompt, harness, model, cwd, kind, wake_parent, status, created_at, expires_at, wider_sandbox, turn_id, call_id, offer, background, effort, worktree, worktree_default)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      proposalWorktree: prepare('UPDATE proposals SET worktree=? WHERE id=?'),
      holdOffer: prepare(
        `UPDATE proposals SET status='pending', title=?, prompt=?, background=?, harness=?, model=?, effort=?, cwd=?, kind=?, wider_sandbox=?, expires_at=?
         WHERE id=? AND status='chosen'`,
      ),
      proposal: prepare('SELECT * FROM proposals WHERE id=?'),
      // 还在等的：等用户点的卡、等用户选的 offer 卡、用户选了新会话等模型补简报的
      pending: prepare(
        "SELECT * FROM proposals WHERE thread_id=? AND status IN ('pending', 'offered', 'chosen') ORDER BY created_at, rowid",
      ),
      recent: prepare(
        'SELECT * FROM proposals WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      ),
      inTurn: prepare('SELECT COUNT(*) AS n FROM proposals WHERE thread_id=? AND turn_id=?'),
      expiring: prepare("SELECT * FROM proposals WHERE status='pending' AND expires_at<=?"),
      moveProposal: prepare(
        'UPDATE proposals SET status=?, started_thread_id=?, settled_at=? WHERE id=? AND status IN (SELECT value FROM json_each(?))',
      ),
      settleOffers: prepare(
        "UPDATE proposals SET status='here', settled_at=? WHERE status IN ('offered', 'chosen')",
      ),
      nextExpiry: prepare("SELECT MIN(expires_at) AS at FROM proposals WHERE status='pending'"),
      addNote: prepare(
        `INSERT INTO notes(parent_thread_id, thread_id, title, status, excerpt, wake, created_at, background, error, user_stopped)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      muteNotes: prepare('UPDATE notes SET wake=0, user_stopped=? WHERE thread_id=?'),
      notes: prepare('SELECT * FROM notes WHERE parent_thread_id=? ORDER BY seq'),
      noteParents: prepare('SELECT DISTINCT parent_thread_id FROM notes'),
      dropNotes: prepare('DELETE FROM notes WHERE parent_thread_id=? AND seq<=?'),
      wakes: prepare('SELECT count FROM wakes WHERE thread_id=?'),
      setWakes: prepare(
        'INSERT INTO wakes(thread_id, count) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET count=excluded.count',
      ),
      tools: prepare('SELECT tools FROM thread_tools WHERE thread_id=?'),
      toolThreads: prepare('SELECT thread_id FROM thread_tools'),
      chore: prepare('SELECT 1 AS pending FROM chores WHERE name=?'),
      choreDone: prepare('DELETE FROM chores WHERE name=?'),
      dropTools: prepare('DELETE FROM thread_tools WHERE thread_id=?'),
      setTools: prepare(
        'INSERT INTO thread_tools(thread_id, tools) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET tools=excluded.tools',
      ),
      instructions: prepare('SELECT * FROM thread_instructions WHERE thread_id=?'),
      setInstructions: prepare(
        `INSERT INTO thread_instructions(thread_id, given, namespaces, cwd) VALUES(?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET given=excluded.given, namespaces=excluded.namespaces, cwd=excluded.cwd`,
      ),
      speed: prepare('SELECT speed FROM thread_speeds WHERE thread_id=?'),
      setSpeed: prepare(
        `INSERT INTO thread_speeds(thread_id, speed) VALUES(?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET speed=excluded.speed`,
      ),
      dropSpeed: prepare('DELETE FROM thread_speeds WHERE thread_id=?'),
      addContact: prepare('INSERT OR IGNORE INTO contacts(a, b, created_at) VALUES(?, ?, ?)'),
      contacted: prepare('SELECT 1 AS hit FROM contacts WHERE a=? AND b=?'),
      dropContacts: prepare('DELETE FROM contacts WHERE a=? OR b=?'),
      option: prepare('SELECT value FROM harness_options WHERE harness=? AND key=?'),
      setOption: prepare(
        `INSERT INTO harness_options(harness, key, value) VALUES(?, ?, ?)
         ON CONFLICT(harness, key) DO UPDATE SET value=excluded.value`,
      ),
      clearOption: prepare('DELETE FROM harness_options WHERE harness=? AND key=?'),
    }
  }

  private run(name: string, ...values: (string | number | null)[]): void {
    this.statements[name]?.run(...values)
  }

  recordResponse(record: SessionDelegatedResponse): void {
    this.db
      .prepare('INSERT INTO delegated_responses(id, thread_id, record) VALUES(?, ?, ?)')
      .run(record.id, record.threadId, JSON.stringify(record))
  }

  dropResponses(threadId: string): void {
    this.db.prepare('DELETE FROM delegated_responses WHERE thread_id=?').run(threadId)
  }

  responses(threadId: string): SessionDelegatedResponse[] {
    return this.db
      .prepare(
        'SELECT record FROM delegated_responses WHERE thread_id=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(threadId)
      .reverse()
      .map((row) => JSON.parse(String(row.record)) as SessionDelegatedResponse)
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
      row.proposalId ?? null,
    )
    this.lineage.set(row.threadId, full)
    // 派子会话就是父会话给它发了第一条消息：之后两边一直可以互相发
    this.addContact(row.parentThreadId, row.threadId)
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

  /** 落一张提案：普通的从 pending 起，offer 卡从 offered 起 */
  addProposal(
    proposal: Omit<SessionProposal, 'status' | 'startedThreadId' | 'settledAt'>,
  ): SessionProposal {
    const status: SessionProposalStatus = proposal.offer ? 'offered' : 'pending'
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
      status,
      proposal.createdAt,
      proposal.expiresAt,
      proposal.widerSandbox ?? null,
      proposal.turnId ?? null,
      proposal.callId ?? null,
      proposal.offer ? 1 : 0,
      proposal.background ?? '',
      proposal.effort ?? null,
      proposal.worktree == null ? null : proposal.worktree ? 1 : 0,
      proposal.worktreeDefault ? 1 : 0,
    )
    return {
      ...proposal,
      background: proposal.background ?? '',
      effort: proposal.effort ?? null,
      status,
      startedThreadId: null,
      settledAt: null,
      turnId: proposal.turnId ?? null,
      callId: proposal.callId ?? null,
      worktree: proposal.worktree ?? null,
      worktreeDefault: proposal.worktreeDefault ?? false,
    }
  }

  /** 用户在 offer 卡上选新会话时定了工作树开关 */
  setProposalWorktree(id: string, worktree: boolean): void {
    this.run('proposalWorktree', worktree ? 1 : 0, id)
  }

  /**
   * 选了新会话的 offer 卡（chosen），模型补的简报开到收不紧沙箱的 harness 上：不开，带着简报改成普通的 pending 提案，
   * 记下 widerSandbox，从这一刻起算过期。已经不是 chosen 了返回 false
   */
  holdOffer(
    id: string,
    brief: Pick<
      SessionProposal,
      'title' | 'prompt' | 'background' | 'harness' | 'model' | 'effort' | 'cwd' | 'kind'
    > & { widerSandbox: string; expiresAt: number },
  ): boolean {
    const result = this.statements.holdOffer?.run(
      brief.title,
      brief.prompt,
      brief.background ?? '',
      brief.harness,
      brief.model,
      brief.effort ?? null,
      brief.cwd,
      brief.kind,
      brief.widerSandbox,
      brief.expiresAt,
      id,
    )
    return Number(result?.changes ?? 0) > 0
  }

  proposal(id: string): SessionProposal | null {
    const row = this.statements.proposal?.get(id)
    return row ? proposalOf(row) : null
  }

  /** 一个会话上还在等的提案（pending、offered、chosen），先提的在前 */
  pending(threadId: string): SessionProposal[] {
    return (this.statements.pending?.all(threadId) ?? []).map(proposalOf)
  }

  /** 一个会话上的提案，连了结的，新的在前，最多 limit 条 */
  recent(threadId: string, limit: number): SessionProposal[] {
    return (this.statements.recent?.all(threadId, limit) ?? []).map(proposalOf)
  }

  /** 这个会话在这个回合里提过几张提案（任何状态） */
  countInTurn(threadId: string, turnId: string): number {
    return Number(this.statements.inTurn?.get(threadId, turnId)?.n ?? 0)
  }

  /**
   * 把一个提案从 from 里的某个状态改成 status。改成 chosen（用户选了新会话、还没了结）时不记了结时间，
   * 别的记下。已经不在 from 里了返回 false
   */
  moveProposal(
    id: string,
    from: readonly SessionProposalStatus[],
    status: SessionProposalStatus,
    startedThreadId: string | null,
  ): boolean {
    const settledAt = status === 'chosen' ? null : now()
    const result = this.statements.moveProposal?.run(
      status,
      startedThreadId,
      settledAt,
      id,
      JSON.stringify(from),
    )
    return Number(result?.changes ?? 0) > 0
  }

  /** 把一个 pending 的提案了结（开始、不要、撤回、过期）。已经不是 pending 了返回 false */
  settleProposal(
    id: string,
    status: SessionProposalStatus,
    startedThreadId: string | null,
  ): boolean {
    return this.moveProposal(id, ['pending'], status, startedThreadId)
  }

  /** 设备进程重启：上一次还在等的 offer 卡（offered、chosen）那次调用已经没了，一律当作在这里做了结 */
  settleOffers(): number {
    const result = this.statements.settleOffers?.run(now())
    return Number(result?.changes ?? 0)
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
      note.backgroundTasks ?? 0,
      note.error ?? null,
      note.userStopped ?? null,
    )
  }

  /** 用户亲手停下了这个子会话：它排着的回报都不再唤醒父会话，注明怎么停的 */
  muteNotes(threadId: string, userStopped: NonNullable<SessionEventNote['userStopped']>): void {
    this.run('muteNotes', userStopped, threadId)
  }

  notes(parentThreadId: string): QueuedNote[] {
    return (this.statements.notes?.all(parentThreadId) ?? []).map((row) => ({
      seq: Number(row.seq),
      at: Number(row.created_at),
      threadId: text(row.thread_id),
      title: text(row.title),
      status: text(row.status) as SessionEventNote['status'],
      excerpt: text(row.excerpt),
      ...(Number(row.background) > 0 ? { backgroundTasks: Number(row.background) } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(row.user_stopped === 'interrupted' || row.user_stopped === 'archived'
        ? { userStopped: row.user_stopped }
        : {}),
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

  /** 会话删掉了：它带的动态工具跟着删 */
  dropTools(threadId: string): void {
    this.run('dropTools', threadId)
  }

  // ---------- 原生 codex 会话的速度（codex-speeds.mts） ----------

  speed(threadId: string): string | null {
    const raw = this.statements.speed?.get(threadId)?.speed
    return typeof raw === 'string' ? raw : null
  }

  setSpeed(threadId: string, speed: string | null): void {
    if (speed === null) this.run('dropSpeed', threadId)
    else this.run('setSpeed', threadId, speed)
  }

  // ---------- 发过消息的会话 ----------

  /**
   * 一个会话给另一个发过消息（send、打断、用户 @、派子会话、别的会话经 harness 自己的收件箱发来……）：
   * 记下这一对，之后两边一直可以互相发消息（session-tools.mts 的 writable）。不分方向，归档、恢复都不影响
   */
  addContact(from: string, to: string): void {
    if (!from || !to || from === to) return
    const [a, b] = from < to ? [from, to] : [to, from]
    this.run('addContact', a, b, now())
  }

  /** 两个会话之间发过消息（谁发给谁都算） */
  contacted(one: string, other: string): boolean {
    const [a, b] = one < other ? [one, other] : [other, one]
    return this.statements.contacted?.get(a, b) !== undefined
  }

  /** 会话删掉了：和它有关的都不留 */
  dropContacts(threadId: string): void {
    this.run('dropContacts', threadId, threadId)
  }

  /** 只做一次的整理还没做 */
  chore(name: string): boolean {
    return this.statements.chore?.get(name) !== undefined
  }

  choreDone(name: string): void {
    this.run('choreDone', name)
  }

  /** 清掉 known 说不认识的会话的那一行，返回清掉几行 */
  pruneTools(known: (threadId: string) => boolean): number {
    let dropped = 0
    for (const row of this.statements.toolThreads?.all() ?? []) {
      const threadId = text(row.thread_id)
      if (known(threadId)) continue
      this.run('dropTools', threadId)
      dropped++
    }
    return dropped
  }

  // ---------- 原生 codex 的开发者指令 ----------

  instructions(threadId: string): ThreadInstructions | null {
    const row = this.statements.instructions?.get(threadId)
    if (!row) return null
    let namespaces: ThreadInstructions['namespaces'] = []
    try {
      const parsed = JSON.parse(text(row.namespaces))
      if (Array.isArray(parsed))
        namespaces = parsed.filter(
          (one) => typeof one?.name === 'string' && typeof one?.instructions === 'string',
        )
    } catch {
      // 坏了的当作没有规则
    }
    return { given: maybe(row.given), namespaces, cwd: maybe(row.cwd) }
  }

  setInstructions(threadId: string, record: ThreadInstructions): void {
    this.run(
      'setInstructions',
      threadId,
      record.given,
      JSON.stringify(record.namespaces),
      record.cwd,
    )
  }

  // ---------- Litch 替 harness 做的功能的开关 ----------

  /** 写过的值；没写过、坏了的是 undefined（按默认） */
  option(harness: string, key: string): unknown {
    const raw = this.statements.option?.get(harness, key)?.value
    if (typeof raw !== 'string') return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  /** null：清掉，回到默认 */
  setOption(harness: string, key: string, value: unknown): void {
    if (value === null || value === undefined) this.run('clearOption', harness, key)
    else this.run('setOption', harness, key, JSON.stringify(value))
  }
}
