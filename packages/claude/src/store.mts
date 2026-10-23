import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { NATIVE_LINEAGE_APPS, type NativeLineageApp } from '../../protocol/src/native-lineage.mjs'
import type { CatalogCursor } from '../../shared/src/catalog-pagination.mjs'
import { ProjectStore, threadsTable } from '../../shared/src/project-store.mjs'
import { QueueStore } from '../../shared/src/queue-store.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { normalizeApprovalPolicy } from './approval-policy.mjs'
import { emptyGoalLedger, type GoalLedger, type GoalState } from './goal-controller.mjs'
import { type HookEvent, type HookRun, hookItem } from './hook-lifecycle.mjs'
import type { ContextInjection } from './native-context.mjs'
import { ProtocolError, type ThreadRuntimeSettings } from './protocol-contract.mjs'
import type { ThreadAttachment } from './thread-attachments.mjs'
import type { ThreadGoal } from './thread-goals.mjs'
import type {
  JsonValue,
  NativeToolIntent,
  ThreadItem,
  ThreadRecord,
  ThreadSectionAppearance,
  ThreadSectionRecord,
  ThreadStatus,
  ThreadTokenUsage,
  TurnRecord,
  TurnStatus,
} from './types.mjs'
import { adapterHome, jsonClone, newId, nowMillis, nowSeconds } from './util.mjs'

/** 一个原生会话号是怎么来的，见 native_sessions 那张表 */
export type NativeSessionOrigin = 'adapter' | 'imported' | 'dismissed'

export interface NativeSessionRecord {
  threadId: string
  origin: NativeSessionOrigin
  mark: string | null
}

const require = createRequire(import.meta.url)

export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
export const PINNED_SECTION_NAME = 'Pinned'

type DatabaseSync = any

function openDatabase(path: string): DatabaseSync {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSync }
  const db = new sqlite.DatabaseSync(path)
  // 其他连接持有写锁时等待而不是立即报 database is locked。
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** 库里记着的一次原生工具意图（native_tool_intents 的一行） */
export interface StoredNativeToolIntent extends NativeToolIntent {
  threadId: string
  turnId: string
}

const STATUS_SQL = 'SELECT status FROM turns WHERE id = ?'
type StatusQuery = { get(id: string): { status: unknown } | undefined }
const LOG_SQL =
  'INSERT INTO turn_item_log (turn_id, kind, position, item_id, item_json) VALUES (?, ?, ?, ?, ?)'
type LogStatement = { run(...values: unknown[]): unknown }

/** 流式的字接到条目上：各种条目放字的地方不一样，没有流式内容的条目原样不动 */
function withStreamedText(item: ThreadItem, text: string): ThreadItem {
  if (item.type === 'agentMessage' || item.type === 'plan')
    return { ...item, text: item.text + text }
  if (item.type === 'reasoning') return { ...item, summary: [(item.summary[0] ?? '') + text] }
  if (item.type === 'commandExecution')
    return { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${text}` }
  return item
}

/** 条目的一笔改动：set 换掉第几个，add 接在最后，move 把第几个拿掉、换成新的接在最后 */
type ItemChange = 'set' | 'add' | 'move'

/**
 * 把一笔改动用到条目上。内存里改和从库里重放都走这里，所以两边得到的一样。
 * set、move 记的是第几个、原来那一个的标识（换上去的条目标识可能不同）；对不上时（不该发生）按标识找，
 * 找不到的 set 不用，move 只接在最后。
 */
function applyChange(
  items: ThreadItem[],
  change: ItemChange,
  position: number,
  replaced: string,
  item: ThreadItem,
): void {
  if (change === 'add') {
    items.push(item)
    return
  }
  const index =
    items[position]?.id === replaced ? position : items.findIndex((entry) => entry.id === replaced)
  if (change === 'set') {
    if (index >= 0) items[index] = item
    return
  }
  if (index >= 0) items.splice(index, 1)
  items.push(item)
}

/**
 * 一个回合正被一条一条改着的条目（见 SessionStore 的 appendItem）：库里是 turns 那一行的 items_json
 * 加上 turn_item_log 里之后记下的改动，这里是两样合起来的样子，和从库里读出来的一样。
 */
interface LiveTurn {
  items: ThreadItem[]
  /** turn_item_log 里这个回合还有几行（合进 items_json 时清掉） */
  logged: number
}

export class SessionStore {
  private db: DatabaseSync
  readonly projects: ProjectStore
  readonly queue: QueueStore
  /** 记了一笔、还没写进库的流式内容（见 appendTextLater）：回合标识 → 条目标识 → 攒着的字 */
  private readonly unsaved = new Map<string, Map<string, string>>()
  /** 正被一条一条改着条目的回合（见 appendItem）：回合标识 → 条目合起来的样子 */
  private readonly live = new Map<string, LiveTurn>()
  /** turnStatus 用的查询语句，头一次问的时候备好 */
  private statusQuery: StatusQuery | null = null
  /** 记条目改动的语句，头一次记的时候备好 */
  private logStatement: LogStatement | null = null

  constructor(path = join(adapterHome(), 'state.sqlite')) {
    assertStoreFormat(path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = openDatabase(path)
    initializeStoreFormat(this.db)
    this.initialize()
    this.projects = new ProjectStore(this.db, threadsTable(this.db))
    this.queue = new QueueStore(this.db)
    this.mergeLeftoverChanges()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_runtime_settings (
        thread_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        turn_id TEXT NOT NULL, PRIMARY KEY(thread_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS native_turn_boundaries (
        turn_id TEXT PRIMARY KEY, message_id TEXT NOT NULL
      );
      -- 用过的 Claude Code 原生会话号各是怎么来的（native-sessions.mts）：adapter 是适配器自己的会话用过的
      -- （回退、追加上下文换下来的旧号也留着），imported 是从本机的原生会话导进来的，dismissed 是导进来又被删掉的。
      -- 列本机原生会话时这几种都不再导一遍。mark 是导入的那份历史对应的原生记录（大小和修改时间）
      CREATE TABLE IF NOT EXISTS native_sessions (
        session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, origin TEXT NOT NULL, mark TEXT
      );
      -- 导进来的原生会话认过没有、是不是别的应用派出来的（native-lineage.mts）：每个只认一次。
      -- app 是派出它的应用（claude-desktop），认过、不是派出来的是 NULL
      CREATE TABLE IF NOT EXISTS native_lineage (
        session_id TEXT PRIMARY KEY, app TEXT
      );
      -- 模型的上下文窗口：入口自己跑回合时从 CLI 的结果里记下（model 是请求里的模型名），
      -- 导进来的会话算用量时按模型查（native-sessions.mts 不跑 CLI，拿不到窗口）
      CREATE TABLE IF NOT EXISTS model_windows (
        model TEXT PRIMARY KEY, window INTEGER NOT NULL
      );
      -- 导进来的会话上一次从原生记录里继承的设置（native-record.mts 读的、换成会话设置之后的样子）：
      -- 会话现在的设置还和它一样，说明用户没在入口里改过，原生记录里的设置变了就接着跟；改过的那一项不再跟
      CREATE TABLE IF NOT EXISTS native_settings (
        session_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL
      );
      -- 不是用户发起的回合是谁开的（backgroundTasks 扩展的 litchOrigin）：只记认得出的，用户的回合不记
      CREATE TABLE IF NOT EXISTS turn_origins (
        turn_id TEXT PRIMARY KEY, origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_injections (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
        context_json TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_context_injection
        ON context_injections(thread_id) WHERE committed=0;
      CREATE TABLE IF NOT EXISTS tool_executions (
        thread_id TEXT NOT NULL, call_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        result_json TEXT, PRIMARY KEY(thread_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS native_tool_intents (
        thread_id TEXT NOT NULL, call_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        session_key TEXT NOT NULL, transcript_path TEXT NOT NULL, agent_id TEXT,
        tool TEXT NOT NULL, input_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS thread_goals (
        thread_id TEXT PRIMARY KEY, goal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_ledgers (
        thread_id TEXT PRIMARY KEY, ledger_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_usage (
        thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, usage_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_attachments (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, attachment_type TEXT NOT NULL,
        identity_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(thread_id, attachment_type, identity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_attachments_page
        ON thread_attachments(thread_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS hook_runs (
        turn_id TEXT NOT NULL, hook_id TEXT NOT NULL, run_json TEXT NOT NULL,
        PRIMARY KEY(turn_id, hook_id)
      );
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        forked_from_id TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        section_id TEXT,
        section_entered_at INTEGER,
        section_position INTEGER,
        preview TEXT NOT NULL,
        name TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        model_provider TEXT NOT NULL,
        claude_session_id TEXT,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        approval_policy TEXT,
        sandbox_mode TEXT,
        permission_profile_id TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        thread_source TEXT,
        agent_role TEXT,
        agent_nickname TEXT,
        base_instructions TEXT,
        developer_instructions TEXT,
        personality TEXT,
        runtime_backend TEXT NOT NULL DEFAULT 'claude',
        codex_session_id TEXT,
        status_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        items_json TEXT NOT NULL,
        diff TEXT NOT NULL DEFAULT '',
        error_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, started_at);
      -- 回合里条目的增减改先一笔一笔记在这里，回合被读、被整行写、结束时才合进 turns.items_json（见 appendItem）
      CREATE TABLE IF NOT EXISTS turn_item_log (
        seq INTEGER PRIMARY KEY,
        turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        item_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_item_log_turn ON turn_item_log(turn_id, seq);
      CREATE TABLE IF NOT EXISTS thread_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        appearance_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_sections_created ON thread_sections(created_at, id);
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_threads_section_position ON threads(section_id, section_position, id)',
    )
    // 有这张表之前建的会话：它们现在用着的原生会话号补记上（以前换下来的旧号已经不知道了，
    // 那些原生记录是 SDK 写的，列本机原生会话时本来就不列）
    this.db.exec(`
      INSERT OR IGNORE INTO native_sessions (session_id, thread_id, origin, mark)
        SELECT claude_session_id, id, 'adapter', NULL FROM threads WHERE claude_session_id IS NOT NULL
    `)
    this.ensurePinnedSection()
  }

  private ensurePinnedSection(): void {
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_sections
         (id, name, appearance_json, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)`,
      )
      .run(PINNED_SECTION_ID, PINNED_SECTION_NAME, now, now)
  }

  upsertThread(thread: ThreadRecord): void {
    const sectionId =
      thread.sectionId === undefined
        ? thread.isPinned === true
          ? PINNED_SECTION_ID
          : null
        : thread.sectionId
    const isPinned = sectionId === PINNED_SECTION_ID
    const sectionEnteredAt =
      sectionId == null ? null : (thread.sectionEnteredAt ?? thread.updatedAt)
    const sectionPosition = sectionId == null ? null : (thread.sectionPosition ?? null)
    this.db
      .prepare(`
        INSERT INTO threads (
          id, session_id, forked_from_id, is_pinned, section_id, section_entered_at, section_position,
          preview, name, archived, cwd, model, reasoning_effort, model_provider, claude_session_id,
          source, created_at, updated_at, status_json,
          approval_policy, sandbox_mode, permission_profile_id, ephemeral, thread_source, agent_role, agent_nickname,
          base_instructions, developer_instructions, personality, runtime_backend, codex_session_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          session_id=excluded.session_id,
          forked_from_id=excluded.forked_from_id,
          is_pinned=excluded.is_pinned,
          section_id=excluded.section_id,
          section_entered_at=excluded.section_entered_at,
          section_position=excluded.section_position,
          preview=excluded.preview,
          name=excluded.name,
          archived=excluded.archived,
          cwd=excluded.cwd,
          model=excluded.model,
          reasoning_effort=excluded.reasoning_effort,
          model_provider=excluded.model_provider,
          claude_session_id=excluded.claude_session_id,
          source=excluded.source,
          updated_at=excluded.updated_at,
          status_json=excluded.status_json,
          approval_policy=excluded.approval_policy,
          sandbox_mode=excluded.sandbox_mode,
          permission_profile_id=excluded.permission_profile_id,
          ephemeral=excluded.ephemeral,
          thread_source=excluded.thread_source,
          agent_role=excluded.agent_role,
          agent_nickname=excluded.agent_nickname,
          base_instructions=excluded.base_instructions,
          developer_instructions=excluded.developer_instructions,
          personality=excluded.personality,
          runtime_backend=excluded.runtime_backend,
          codex_session_id=excluded.codex_session_id
      `)
      .run(
        thread.id,
        thread.sessionId,
        thread.forkedFromId,
        isPinned ? 1 : 0,
        sectionId,
        sectionEnteredAt,
        sectionPosition,
        thread.preview,
        thread.name,
        thread.archived ? 1 : 0,
        thread.cwd,
        thread.model,
        thread.reasoningEffort,
        thread.modelProvider,
        thread.claudeSessionId,
        thread.source,
        thread.createdAt,
        thread.updatedAt,
        JSON.stringify(thread.status),
        typeof thread.approvalPolicy === 'object' && thread.approvalPolicy !== null
          ? JSON.stringify(thread.approvalPolicy)
          : thread.approvalPolicy,
        thread.sandboxMode,
        thread.permissionProfileId ?? null,
        thread.ephemeral ? 1 : 0,
        thread.threadSource,
        thread.agentRole,
        thread.agentNickname,
        thread.baseInstructions,
        thread.developerInstructions,
        thread.personality,
        thread.runtimeBackend,
        thread.codexSessionId,
      )
    if (thread.claudeSessionId) this.claimNativeSession(thread.claudeSessionId, thread.id)
  }

  /** 这个原生会话号归这个会话用了。已经记过的（导入的、别的会话的）不动 */
  private claimNativeSession(sessionId: string, threadId: string): void {
    this.db
      .prepare(
        "INSERT INTO native_sessions (session_id, thread_id, origin, mark) VALUES (?, ?, 'adapter', NULL) ON CONFLICT(session_id) DO NOTHING",
      )
      .run(sessionId, threadId)
  }

  /** 记过的原生会话号：会话号 → 归哪个会话、怎么来的、导入的历史对应哪一份记录 */
  nativeSessions(): Map<string, NativeSessionRecord> {
    const rows = this.db
      .prepare('SELECT session_id, thread_id, origin, mark FROM native_sessions')
      .all() as Array<{
      session_id: string
      thread_id: string
      origin: string
      mark: string | null
    }>
    return new Map(
      rows.map((row) => [
        row.session_id,
        { threadId: row.thread_id, origin: row.origin as NativeSessionOrigin, mark: row.mark },
      ]),
    )
  }

  /** 导入一个原生会话：先记下它是导进来的，再建会话（建的时候不会被当成适配器自己的） */
  importNativeSession(sessionId: string, thread: ThreadRecord): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          "INSERT INTO native_sessions (session_id, thread_id, origin, mark) VALUES (?, ?, 'imported', NULL)",
        )
        .run(sessionId, thread.id)
      this.upsertThread(thread)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 认过的原生会话：会话号 → 派出它的应用（不是派出来的是 null）。常驻内存，会话对象每次出门都要查 */
  private lineage: Map<string, NativeLineageApp | null> | null = null

  nativeLineage(): ReadonlyMap<string, NativeLineageApp | null> {
    if (!this.lineage) {
      const rows = this.db.prepare('SELECT session_id, app FROM native_lineage').all() as Array<{
        session_id: string
        app: string | null
      }>
      this.lineage = new Map(
        rows.map((row) => [
          row.session_id,
          (NATIVE_LINEAGE_APPS as readonly string[]).includes(row.app ?? '')
            ? (row.app as NativeLineageApp)
            : null,
        ]),
      )
    }
    return this.lineage
  }

  /** 记下一个不是用户发起的回合是谁开的 */
  saveTurnOrigin(turnId: string, origin: string): void {
    this.db
      .prepare(
        'INSERT INTO turn_origins (turn_id, origin) VALUES (?, ?) ON CONFLICT(turn_id) DO UPDATE SET origin=excluded.origin',
      )
      .run(turnId, origin)
  }

  /** 这几个回合里记过来历的：回合 → 谁开的 */
  turnOrigins(turnIds: readonly string[]): Map<string, string> {
    const found = new Map<string, string>()
    if (turnIds.length === 0) return found
    const select = this.db.prepare('SELECT origin FROM turn_origins WHERE turn_id = ?')
    for (const id of turnIds) {
      const row = select.get(id) as { origin: string } | undefined
      if (row) found.set(id, row.origin)
    }
    return found
  }

  /** 记下一个模型的上下文窗口（后记的盖掉先记的） */
  saveModelWindow(model: string, window: number): void {
    this.db
      .prepare(
        'INSERT INTO model_windows (model, window) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET window=excluded.window',
      )
      .run(model, window)
  }

  /** 一个模型的上下文窗口，没记过是 null */
  modelWindow(model: string): number | null {
    const row = this.db.prepare('SELECT window FROM model_windows WHERE model=?').get(model) as
      | { window: number }
      | undefined
    return row ? Number(row.window) : null
  }

  /** 导进来的会话上一次继承的设置，没继承过是 null */
  nativeSettings(sessionId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT settings_json FROM native_settings WHERE session_id=?')
      .get(sessionId) as { settings_json: string } | undefined
    return row ? (JSON.parse(row.settings_json) as Record<string, unknown>) : null
  }

  saveNativeSettings(sessionId: string, settings: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO native_settings (session_id, settings_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET settings_json=excluded.settings_json',
      )
      .run(sessionId, JSON.stringify(settings))
  }

  /** 记下认的结果（每个会话只认一次） */
  saveNativeLineage(sessionId: string, app: NativeLineageApp | null): void {
    this.db
      .prepare(
        'INSERT INTO native_lineage (session_id, app) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET app=excluded.app',
      )
      .run(sessionId, app)
    this.lineage = new Map(this.nativeLineage()).set(sessionId, app)
  }

  /**
   * 换上一份从原生记录画出来的历史：keep 个回合原样留着（已经在库里、和原生记录对得上的），
   * 后面的整个换成 turns。mark 记下这份历史对应的原生记录
   */
  replaceNativeHistory(
    threadId: string,
    sessionId: string,
    keep: number,
    turns: readonly TurnRecord[],
    boundaries: ReadonlyMap<string, string>,
    mark: string,
  ): void {
    this.flushAll()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const drop = this.listTurns(threadId).slice(keep)
      for (const turn of drop) {
        this.db.prepare('DELETE FROM hook_runs WHERE turn_id=?').run(turn.id)
        this.db.prepare('DELETE FROM native_turn_boundaries WHERE turn_id=?').run(turn.id)
        this.db.prepare('DELETE FROM turn_origins WHERE turn_id=?').run(turn.id)
        this.db.prepare('DELETE FROM turns WHERE id=?').run(turn.id)
      }
      for (const turn of turns) {
        this.writeTurn(turn)
        const boundary = boundaries.get(turn.id)
        if (boundary) this.saveNativeBoundary(turn.id, boundary)
      }
      this.db.prepare('UPDATE native_sessions SET mark=? WHERE session_id=?').run(mark, sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getThread(id: string): ThreadRecord | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
    return row ? this.rowToThread(row) : null
  }

  // 全部临时会话（含它们的子代理会话）：入口启动时这些都是上次留下的，没有连接能再订阅它们。
  ephemeralThreads(): ThreadRecord[] {
    return this.db
      .prepare('SELECT * FROM threads WHERE ephemeral = 1 ORDER BY created_at, id')
      .all()
      .map((row: unknown) => this.rowToThread(row))
  }

  // 没归档的会话用着的模型（去重）：model/list 要让每个会话报的模型都找得到对应的一行。
  threadModels(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT model FROM threads WHERE archived = 0 ORDER BY model')
      .all() as Array<{ model: string }>
    return rows.map((row) => row.model)
  }

  addAttachment(
    threadId: string,
    attachmentType: string,
    identityKey: string,
    payload: JsonValue,
  ): { outcome: 'created' | 'existing'; attachment: ThreadAttachment } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.db
        .prepare(`
        INSERT INTO thread_attachments(id, thread_id, attachment_type, identity_key, payload_json, created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id, attachment_type, identity_key) DO NOTHING
      `)
        .run(newId(), threadId, attachmentType, identityKey, JSON.stringify(payload), nowSeconds())
      const row = this.db
        .prepare(`
        SELECT id, attachment_type AS attachmentType, identity_key AS identityKey,
          payload_json AS payload, created_at AS createdAt FROM thread_attachments
        WHERE thread_id=? AND attachment_type=? AND identity_key=?
      `)
        .get(threadId, attachmentType, identityKey)
      const attachment: ThreadAttachment = { ...row, payload: JSON.parse(row.payload) }
      this.db.exec('COMMIT')
      return { outcome: inserted.changes === 1 ? 'created' : 'existing', attachment }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listAttachments(
    threadId: string,
    limit: number,
    cursor: CatalogCursor | null,
  ): ThreadAttachment[] {
    const rows = this.db
      .prepare(`
      SELECT id, attachment_type AS attachmentType, identity_key AS identityKey,
        payload_json AS payload, created_at AS createdAt FROM thread_attachments
      WHERE thread_id=? ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `)
      .all(threadId, ...(cursor ? [cursor.value, cursor.value, cursor.id] : []), limit) as Array<
      Omit<ThreadAttachment, 'payload'> & { payload: string }
    >
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as JsonValue }))
  }

  removeAttachment(threadId: string, attachmentType: string, identityKey: string): string | null {
    const row = this.db
      .prepare(`
      DELETE FROM thread_attachments WHERE thread_id=? AND attachment_type=? AND identity_key=?
      RETURNING id
    `)
      .get(threadId, attachmentType, identityKey)
    return row?.id ?? null
  }

  // thread/attachmentOwner/list：按附件身份反查持有它的会话。archived 为 null 时不分归档与否。
  listAttachmentOwners(
    attachmentType: string,
    identityKey: string,
    archived: boolean | null,
    limit: number,
    cursor: CatalogCursor | null,
  ): Array<{ id: string; createdAt: number; threadId: string; archived: boolean }> {
    const rows = this.db
      .prepare(`
      SELECT a.id AS id, a.created_at AS createdAt, a.thread_id AS threadId, t.archived AS archived
      FROM thread_attachments a JOIN threads t ON t.id = a.thread_id
      WHERE a.attachment_type=? AND a.identity_key=? ${archived == null ? '' : 'AND t.archived=?'}
        ${cursor ? 'AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))' : ''}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?
    `)
      .all(
        attachmentType,
        identityKey,
        ...(archived == null ? [] : [archived ? 1 : 0]),
        ...(cursor ? [cursor.value, cursor.value, cursor.id] : []),
        limit,
      ) as Array<{ id: string; createdAt: number; threadId: string; archived: number }>
    return rows.map((row) => ({ ...row, archived: row.archived === 1 }))
  }

  listThreads(
    options: {
      archived?: boolean | null
      limit?: number | null
      cursor?: CatalogCursor | null
      modelProviders?: string[]
      searchTerm?: string | null
      // 先排除这些会话再截取一页（thread/list 的 excludedThreadIds，0.163.0 起）
      excludedThreadIds?: string[]
      isPinned?: boolean | null
      cwd?: string | string[] | null
      includeEphemeral?: boolean
      // 只列预览不为空（说过话）的会话
      requirePreview?: boolean
      parentThreadId?: string | null
      ancestorThreadId?: string | null
      sourceKinds?: string[] | undefined
      sectionId?: string | null | undefined
      projectId?: string | null | undefined
      sortKey?: 'created_at' | 'updated_at' | 'recency_at' | 'section_position'
      sortDirection?: 'asc' | 'desc'
    } = {},
  ): ThreadRecord[] {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 1001))
    const archived = options.archived === true ? 1 : 0
    const sortKey =
      options.sortKey === 'updated_at' ||
      options.sortKey === 'recency_at' ||
      options.sortKey === 'section_position'
        ? options.sortKey
        : 'created_at'
    const sortExpression =
      sortKey === 'section_position'
        ? 'COALESCE(t.section_position, t.created_at)'
        : `t.${sortKey === 'created_at' ? 'created_at' : 'updated_at'}`
    const sortDirection = options.sortDirection === 'asc' ? 'ASC' : 'DESC'
    const where = ['t.archived = ?']
    const args: unknown[] = [archived]
    if (options.cursor) {
      const comparator =
        (sortDirection === 'ASC' ? '>' : '<') + (options.cursor.inclusive ? '=' : '')
      // 时间戳精度为秒，必须加 ID 作为稳定排序键，否则同秒会话会在翻页时丢失。
      where.push(`(${sortExpression}, t.id) ${comparator} (?, ?)`)
      args.push(options.cursor.value, options.cursor.id)
    }
    if (options.modelProviders?.length) {
      where.push(`t.model_provider IN (${options.modelProviders.map(() => '?').join(',')})`)
      args.push(...options.modelProviders)
    }
    if (options.searchTerm) {
      where.push("instr(lower(COALESCE(NULLIF(t.name,''), t.preview)), lower(?)) > 0")
      args.push(options.searchTerm)
    }
    if (options.excludedThreadIds?.length) {
      where.push(`t.id NOT IN (${options.excludedThreadIds.map(() => '?').join(',')})`)
      args.push(...options.excludedThreadIds)
    }
    if (options.requirePreview) where.push("t.preview <> ''")
    if (options.isPinned != null) {
      where.push('t.is_pinned = ?')
      args.push(options.isPinned ? 1 : 0)
    }
    if (options.sectionId !== undefined) {
      if (options.sectionId === null) {
        where.push('t.section_id IS NULL')
      } else {
        where.push('t.section_id = ?')
        args.push(options.sectionId)
      }
    }
    if (options.projectId !== undefined) {
      const membership = `SELECT thread_id FROM project_threads
        ${options.projectId === null ? '' : 'WHERE project_id=?'} UNION ALL
        SELECT thread_id FROM live_project_threads ${options.projectId === null ? '' : 'WHERE project_id=?'}`
      where.push(`t.id ${options.projectId === null ? 'NOT IN' : 'IN'} (${membership})`)
      if (options.projectId !== null) args.push(options.projectId, options.projectId)
    }
    const parentThreadId = options.parentThreadId ?? null
    const ancestorThreadId = options.ancestorThreadId ?? null
    // 不传来源表示不按来源过滤；传空数组表示只列用户自己的线程（见下）。
    const sourceKinds = options.sourceKinds ?? null

    if (parentThreadId != null) {
      where.push('t.forked_from_id = ?')
      args.push(parentThreadId)
    }
    if (ancestorThreadId != null) {
      where.push('t.id IN (SELECT id FROM descendants)')
    }

    if (sourceKinds?.length === 0) {
      // 子代理线程的来源是 subAgent，不算用户自己的线程：只在按来源查，或按父线程、
      // 祖先线程查且不指定来源时返回。与 Codex 原生对空来源的处理一致。
      where.push("(t.thread_source IS NOT 'subagent' OR t.forked_from_id IS NULL)")
    } else if (sourceKinds) {
      const predicates = sourceKinds.flatMap((kind) => {
        switch (kind) {
          case 'subAgent':
          case 'subAgentThreadSpawn':
            return ["(t.thread_source = 'subagent' AND t.forked_from_id IS NOT NULL)"]
          case 'subAgentReview':
          case 'subAgentCompact':
          case 'subAgentOther':
            // These source kinds need a persisted discriminator that this
            // adapter does not have. Fail closed instead of mislabelling a
            // thread-spawn child as a review/compact/other subagent.
            return []
          case 'user':
            return ["t.thread_source = 'user'"]
          case 'memoryConsolidation':
            return ["t.thread_source = 'memory_consolidation'"]
          case 'appServer':
          case 'cli':
          case 'exec':
          case 'vscode':
          case 'unknown':
            return [`t.source = '${kind}'`]
          default:
            return []
        }
      })
      where.push(predicates.length > 0 ? `(${predicates.join(' OR ')})` : '1 = 0')
    }

    // Ephemeral threads (Codex App's internal title generators,
    // memory-consolidation runs) shouldn't appear in the user's session list.
    // Topology queries are the exception: a subagent child carries its
    // parent's flag, and Codex App asks for subagent descendants without
    // sending our legacy includeEphemeral flag.
    const hasSubagentSourceFilter = (sourceKinds ?? []).some((kind) =>
      ['subAgent', 'subAgentThreadSpawn'].includes(kind),
    )
    const topologyQuery =
      parentThreadId != null || ancestorThreadId != null || hasSubagentSourceFilter
    if (!options.includeEphemeral && !topologyQuery) where.push('t.ephemeral = 0')

    const cwdList = Array.isArray(options.cwd) ? options.cwd : options.cwd ? [options.cwd] : []
    if (cwdList.length > 0) {
      const placeholders = cwdList.map(() => '?').join(',')
      where.push(`t.cwd IN (${placeholders})`)
      args.push(...cwdList)
    }

    const cte =
      ancestorThreadId == null
        ? ''
        : `WITH RECURSIVE descendants(id) AS (
            SELECT id FROM threads WHERE forked_from_id = ?
            UNION
            SELECT child.id FROM threads child JOIN descendants parent ON child.forked_from_id = parent.id
          )`
    const queryArgs = ancestorThreadId == null ? args : [ancestorThreadId, ...args]
    const rows = this.db
      .prepare(
        `${cte} SELECT t.* FROM threads t WHERE ${where.join(' AND ')} ORDER BY ${sortExpression} ${sortDirection}, t.id ${sortDirection} LIMIT ?`,
      )
      .all(...queryArgs, limit)
    return rows.map((row: unknown) => this.rowToThread(row))
  }

  listSections(limit = 100, cursor: string | null = null): ThreadSectionRecord[] {
    const boundedLimit = Math.max(1, Math.min(Number(limit || 100), 200))
    const offset = cursor == null ? 0 : Math.max(0, Number(cursor) || 0)
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_sections
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(PINNED_SECTION_ID, boundedLimit, offset)
    return rows.map((row: unknown) => this.rowToSection(row))
  }

  getSection(id: string): ThreadSectionRecord | null {
    const row = this.db.prepare('SELECT * FROM thread_sections WHERE id = ?').get(id)
    if (row) return this.rowToSection(row)
    // Keep the reserved section available even if a hand-created legacy DB was
    // opened before the migration seed ran.
    if (id === PINNED_SECTION_ID) {
      return { id: PINNED_SECTION_ID, name: PINNED_SECTION_NAME, appearance: null }
    }
    return null
  }

  createSection(
    id: string,
    name: string,
    appearance: ThreadSectionAppearance | null = null,
  ): ThreadSectionRecord {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error('section name must not be empty')
    if (id === PINNED_SECTION_ID) throw new Error('the pinned section is reserved')
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT INTO thread_sections
         (id, name, appearance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, normalizedName, appearance == null ? null : JSON.stringify(appearance), now, now)
    return this.getSection(id) as ThreadSectionRecord
  }

  updateSection(
    id: string,
    name: string,
    appearance: ThreadSectionAppearance | null = null,
  ): ThreadSectionRecord {
    if (!this.getSection(id)) throw new Error(`unknown section: ${id}`)
    const normalizedName = id === PINNED_SECTION_ID ? PINNED_SECTION_NAME : name.trim()
    if (!normalizedName) throw new Error('section name must not be empty')
    this.db
      .prepare(
        `UPDATE thread_sections
         SET name = ?, appearance_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(normalizedName, appearance == null ? null : JSON.stringify(appearance), nowSeconds(), id)
    return this.getSection(id) as ThreadSectionRecord
  }

  deleteSection(id: string): void {
    if (id === PINNED_SECTION_ID) throw new Error('the pinned section is reserved')
    if (!this.getSection(id)) throw new Error(`unknown section: ${id}`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE threads
           SET section_id = NULL,
               section_entered_at = NULL,
               section_position = NULL,
               is_pinned = 0
           WHERE section_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM thread_sections WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
  }

  moveThreadToSection(
    threadId: string,
    sectionId: string | null,
    beforeThreadId: string | null = null,
  ): ThreadRecord {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (sectionId != null && !this.getSection(sectionId))
      throw new Error(`unknown section: ${sectionId}`)

    const oldSectionId =
      thread.sectionId === undefined
        ? thread.isPinned === true
          ? PINNED_SECTION_ID
          : null
        : (thread.sectionId ?? null)
    const oldIds = this.sectionThreadIds(oldSectionId, threadId)
    const targetIds = sectionId == null ? [] : this.sectionThreadIds(sectionId, threadId)
    let targetPosition: number | null = null
    if (sectionId != null) {
      const beforeIndex = beforeThreadId == null ? -1 : targetIds.indexOf(beforeThreadId)
      targetPosition = beforeIndex >= 0 ? beforeIndex : targetIds.length
      targetIds.splice(targetPosition, 0, threadId)
    }

    const enteredAt =
      sectionId == null
        ? null
        : oldSectionId === sectionId
          ? (thread.sectionEnteredAt ?? nowSeconds())
          : nowSeconds()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (oldSectionId !== sectionId && oldSectionId != null) this.renumberSection(oldIds)
      if (sectionId != null) this.renumberSection(targetIds)
      this.db
        .prepare(
          `UPDATE threads
           SET section_id = ?,
               section_entered_at = ?,
               section_position = ?,
               is_pinned = ?
           WHERE id = ?`,
        )
        .run(
          sectionId,
          enteredAt,
          targetPosition,
          sectionId === PINNED_SECTION_ID ? 1 : 0,
          threadId,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
    const moved = this.getThread(threadId)
    if (!moved) throw new Error(`unknown thread: ${threadId}`)
    return moved
  }

  private sectionThreadIds(sectionId: string | null, excludeThreadId: string): string[] {
    const rows =
      sectionId == null
        ? this.db
            .prepare(
              `SELECT id FROM threads
               WHERE section_id IS NULL AND id <> ?
               ORDER BY COALESCE(section_position, created_at), updated_at, id`,
            )
            .all(excludeThreadId)
        : this.db
            .prepare(
              `SELECT id FROM threads
               WHERE section_id = ? AND id <> ?
               ORDER BY COALESCE(section_position, created_at), updated_at, id`,
            )
            .all(sectionId, excludeThreadId)
    return rows.map((row: any) => String(row.id))
  }

  private renumberSection(threadIds: string[]): void {
    const update = this.db.prepare('UPDATE threads SET section_position = ? WHERE id = ?')
    for (const [position, threadId] of threadIds.entries()) update.run(position, threadId)
  }

  updateThreadStatus(threadId: string, status: ThreadStatus): void {
    this.db
      .prepare('UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(status), nowSeconds(), threadId)
  }

  updateThreadName(threadId: string, name: string | null): void {
    this.db
      .prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, nowSeconds(), threadId)
  }

  updateClaudeSessionId(threadId: string, claudeSessionId: string | null): void {
    this.db
      .prepare('UPDATE threads SET claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(claudeSessionId, nowSeconds(), threadId)
    if (claudeSessionId) this.claimNativeSession(claudeSessionId, threadId)
  }

  // Stored separately from Claude's session id so a thread that was
  // codex-backed can be later inspected without confusing its provenance,
  // and so a codex thread's resume id never collides with a claude session id.
  updateCodexSessionId(threadId: string, codexSessionId: string | null): void {
    this.db
      .prepare('UPDATE threads SET codex_session_id = ?, updated_at = ? WHERE id = ?')
      .run(codexSessionId, nowSeconds(), threadId)
  }

  setArchived(threadId: string, archived: boolean): void {
    this.db
      .prepare('UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, nowSeconds(), threadId)
  }

  upsertTurn(turn: TurnRecord): void {
    this.flush(turn.id)
    this.writeTurn(turn)
  }

  private writeTurn(turn: TurnRecord): void {
    this.db
      .prepare(`
        INSERT INTO turns (id, thread_id, status, started_at, completed_at, duration_ms, items_json, diff, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          started_at=excluded.started_at,
          completed_at=excluded.completed_at,
          duration_ms=excluded.duration_ms,
          items_json=excluded.items_json,
          diff=excluded.diff,
          error_json=excluded.error_json
      `)
      .run(
        turn.id,
        turn.threadId,
        turn.status,
        turn.startedAt,
        turn.completedAt,
        turn.durationMs,
        JSON.stringify(turn.items),
        turn.diff,
        turn.error == null ? null : JSON.stringify(turn.error),
      )
  }

  getTurn(id: string): TurnRecord | null {
    this.flush(id)
    return this.readTurn(id)
  }

  private readTurn(id: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id)
    return row ? this.rowToTurn(row) : null
  }

  /**
   * 只问回合的状态。不取条目，所以不用解析整个回合，也不用先把记着的流式内容写进去（它不改状态）。
   * 每个运行时事件都要问一遍，查询语句备好了留着用，不每次重新编译。
   */
  turnStatus(id: string): TurnStatus | null {
    const query: StatusQuery = this.statusQuery ?? this.db.prepare(STATUS_SQL)
    this.statusQuery = query
    const row = query.get(id)
    return row ? (String(row.status) as TurnStatus) : null
  }

  /**
   * 条目里流式的内容多了一段（正文、计划、思考、命令的输出）：只记一笔，先不写。
   * 每来一条增量就写的话，回答越长每条越贵。记下的这一笔在这个回合下一次被读或被写之前写进去
   * （settle，本类里碰回合表的方法开头都先调它），所以读到的总是最新的，写的先后也和逐条写时一样。
   * 这样做靠的是回合表只有本进程的这一条连接在读：一个状态目录同时只有一个入口进程，
   * 设备进程和共用的项目、队列存储都不碰这张表。进程被强杀时库里少的是最后一次写之后流出来的那一截。
   */
  appendTextLater(turnId: string, itemId: string, delta: string): void {
    let items = this.unsaved.get(turnId)
    if (!items) {
      items = new Map()
      this.unsaved.set(turnId, items)
    }
    items.set(itemId, (items.get(itemId) ?? '') + delta)
  }

  /**
   * 回合的条目合起来的样子：内存里有就用，没有就读 turns 那一行再重放 turn_item_log 里记着的改动，
   * 之后留在内存里，直到回合被读或被整行写（flush）。没有这个回合时是 null
   */
  private liveTurn(turnId: string): LiveTurn | null {
    const cached = this.live.get(turnId)
    if (cached) return cached
    const row = this.db.prepare('SELECT items_json FROM turns WHERE id = ?').get(turnId)
    if (!row) return null
    const items = JSON.parse(String(row.items_json)) as ThreadItem[]
    const changes = this.db
      .prepare(
        'SELECT kind, position, item_id, item_json FROM turn_item_log WHERE turn_id = ? ORDER BY seq',
      )
      .all(turnId) as Array<{ kind: string; position: number; item_id: string; item_json: string }>
    for (const change of changes)
      applyChange(
        items,
        change.kind as ItemChange,
        Number(change.position),
        String(change.item_id),
        JSON.parse(change.item_json),
      )
    const entry: LiveTurn = { items, logged: changes.length }
    this.live.set(turnId, entry)
    return entry
  }

  /**
   * 条目的一笔改动：先在 turn_item_log 里记一行（只有这一个条目），再改内存里那一份。
   * 内存里放的是记下的那段 JSON 再解析出来的，和从库里读出来的一模一样；调用方手里的对象之后怎么改都不影响它。
   */
  private logChange(
    turnId: string,
    live: LiveTurn,
    change: ItemChange,
    position: number,
    item: ThreadItem,
  ): void {
    const replaced = change === 'add' ? item.id : (live.items[position]?.id ?? item.id)
    const json = JSON.stringify(item)
    const statement: LogStatement = this.logStatement ?? this.db.prepare(LOG_SQL)
    this.logStatement = statement
    statement.run(turnId, change, position, replaced, json)
    live.logged += 1
    applyChange(live.items, change, position, replaced, JSON.parse(json))
  }

  /**
   * 把一个回合记着的流式内容记进库：带着字的条目各记一笔改动（只是这几个条目，不是整个回合）。
   * 没记成的（库被占着）留着，下一次再记
   */
  private settle(turnId: string): void {
    const streamed = this.unsaved.get(turnId)
    if (!streamed) return
    const live = this.liveTurn(turnId)
    for (const [itemId, text] of [...streamed]) {
      if (live)
        for (let index = 0; index < live.items.length; index++) {
          const item = live.items[index]
          if (item?.id !== itemId) continue
          const next = withStreamedText(item, text)
          if (next !== item) this.logChange(turnId, live, 'set', index, next)
        }
      streamed.delete(itemId)
    }
    this.unsaved.delete(turnId)
  }

  /**
   * 把一个回合记着的都合进 turns 那一行：流式的字、turn_item_log 里逐条记下的改动。合完之后
   * 那一行就是全的，读它的地方（getTurn、listTurns 和直接查表的）不用知道还有记着的这回事。
   * 写 items_json 和清掉记下的改动在一起，要么都成要么都不成：只成一半的话重放会把改动再用一遍。
   * 外面可能已经开着事务（saveSubmission 一类），所以用保存点。
   */
  private flush(turnId: string): void {
    this.settle(turnId)
    const live = this.live.get(turnId)
    if (!live) return
    if (live.logged > 0) {
      this.db.exec('SAVEPOINT flush_turn')
      try {
        this.db
          .prepare('UPDATE turns SET items_json = ? WHERE id = ?')
          .run(JSON.stringify(live.items), turnId)
        this.db.prepare('DELETE FROM turn_item_log WHERE turn_id = ?').run(turnId)
        this.db.exec('RELEASE flush_turn')
      } catch (error) {
        this.db.exec('ROLLBACK TO flush_turn')
        this.db.exec('RELEASE flush_turn')
        throw error
      }
    }
    this.live.delete(turnId)
  }

  /** 把记着的全合进去：要读写的不止一个回合时、进程退出前 */
  flushAll(): void {
    for (const turnId of new Set([...this.unsaved.keys(), ...this.live.keys()])) this.flush(turnId)
  }

  /**
   * 打开库时：上次的进程没来得及合进去的条目改动（被强杀、崩溃）合进去。
   * 回合已经不在了的（不该有）直接清掉
   */
  private mergeLeftoverChanges(): void {
    const turns = this.db.prepare('SELECT DISTINCT turn_id FROM turn_item_log').all() as Array<{
      turn_id: string
    }>
    for (const { turn_id: turnId } of turns) {
      if (this.liveTurn(turnId)) this.flush(turnId)
      else this.db.prepare('DELETE FROM turn_item_log WHERE turn_id = ?').run(turnId)
    }
  }

  listTurns(threadId: string): TurnRecord[] {
    this.flushAll()
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(threadId)
    return rows.map((row: unknown) => this.rowToTurn(row))
  }

  // 父会话下面的子代理线程（工作流的也在内）。主模型用 SendMessage 续跑子代理时按代理 ID 从里面找回子线程
  subagentThreadIds(parentThreadId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM threads WHERE forked_from_id = ? AND thread_source = 'subagent'")
      .all(parentThreadId) as Array<{ id: string }>
    return rows.map((row) => String(row.id))
  }

  threadSettings(threadId: string): ThreadRuntimeSettings {
    const row = this.db
      .prepare('SELECT settings_json FROM thread_runtime_settings WHERE thread_id=?')
      .get(threadId)
    return row ? JSON.parse(row.settings_json) : {}
  }

  threadGoal(threadId: string): ThreadGoal | null {
    const row = this.db
      .prepare('SELECT goal_json FROM thread_goals WHERE thread_id=?')
      .get(threadId)
    return row ? JSON.parse(row.goal_json) : null
  }

  goalState(threadId: string): GoalState {
    const row = this.db
      .prepare('SELECT ledger_json FROM goal_ledgers WHERE thread_id=?')
      .get(threadId)
    const goal = this.threadGoal(threadId)
    const ledger = row ? (JSON.parse(row.ledger_json) as GoalLedger) : emptyGoalLedger()
    if (!row && goal) ledger.elapsedMs = goal.timeUsedSeconds * 1000
    return { goal, ledger }
  }

  mutateGoalState<T>(threadId: string, action: (state: GoalState) => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.goalState(threadId)
      const result = action(state)
      if (state.goal) this.saveThreadGoal(state.goal)
      else this.clearThreadGoal(threadId)
      this.db
        .prepare(
          'INSERT INTO goal_ledgers VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET ledger_json=excluded.ledger_json',
        )
        .run(threadId, JSON.stringify(state.ledger))
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  hasUncertainTools(threadId: string): boolean {
    return this.uncertainToolIds(threadId).size > 0
  }

  threadUsage(threadId: string): { turnId: string; tokenUsage: ThreadTokenUsage } | null {
    const row = this.db
      .prepare('SELECT turn_id,usage_json FROM thread_usage WHERE thread_id=?')
      .get(threadId)
    return row ? { turnId: row.turn_id, tokenUsage: JSON.parse(row.usage_json) } : null
  }

  saveThreadUsage(threadId: string, turnId: string, usage: ThreadTokenUsage): void {
    this.db
      .prepare(
        'INSERT INTO thread_usage VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id, usage_json=excluded.usage_json',
      )
      .run(threadId, turnId, JSON.stringify(usage))
  }

  saveThreadGoal(goal: ThreadGoal): void {
    this.db
      .prepare(`INSERT INTO thread_goals(thread_id,goal_json) VALUES (?,?)
      ON CONFLICT(thread_id) DO UPDATE SET goal_json=excluded.goal_json`)
      .run(goal.threadId, JSON.stringify(goal))
  }

  clearThreadGoal(threadId: string): boolean {
    return this.db.prepare('DELETE FROM thread_goals WHERE thread_id=?').run(threadId).changes > 0
  }

  reserveTool(threadId: string, callId: string, hash: string): { result: unknown } | null {
    const row = this.db
      .prepare('SELECT * FROM tool_executions WHERE thread_id=? AND call_id=?')
      .get(threadId, callId)
    if (row) {
      if (row.payload_hash !== hash) throw new ProtocolError(-32009, '相同工具调用 ID 的参数冲突')
      if (row.result_json == null)
        throw new ProtocolError(-32010, '工具执行结果不确定，禁止自动重放')
      return { result: JSON.parse(row.result_json) }
    }
    this.db
      .prepare('INSERT INTO tool_executions(thread_id,call_id,payload_hash) VALUES(?,?,?)')
      .run(threadId, callId, hash)
    return null
  }

  /** 原生工具执行之前记下的意图（native-tool-intents.mts）。同一次调用再记一次不动原来的 */
  saveNativeToolIntent(threadId: string, turnId: string, intent: NativeToolIntent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO native_tool_intents
         (thread_id,call_id,turn_id,session_key,transcript_path,agent_id,tool,input_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        threadId,
        intent.callId,
        turnId,
        intent.sessionKey,
        intent.transcriptPath,
        intent.agentId,
        intent.tool,
        JSON.stringify(intent.input ?? null),
        nowMillis(),
      )
  }

  nativeToolIntents(threadId: string): StoredNativeToolIntent[] {
    const rows = this.db
      .prepare('SELECT * FROM native_tool_intents WHERE thread_id=? ORDER BY created_at, rowid')
      .all(threadId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      callId: String(row.call_id),
      tool: String(row.tool),
      input: JSON.parse(String(row.input_json)),
      sessionKey: String(row.session_key),
      transcriptPath: String(row.transcript_path),
      agentId: row.agent_id == null ? null : String(row.agent_id),
    }))
  }

  dropNativeToolIntents(threadId: string, callIds: Iterable<string>): void {
    const remove = this.db.prepare(
      'DELETE FROM native_tool_intents WHERE thread_id=? AND call_id=?',
    )
    for (const callId of callIds) remove.run(threadId, callId)
  }

  completeTool(threadId: string, callId: string, result: unknown): void {
    this.db
      .prepare('UPDATE tool_executions SET result_json=? WHERE thread_id=? AND call_id=?')
      .run(JSON.stringify(result), threadId, callId)
  }

  saveThreadSettings(threadId: string, settings: ThreadRuntimeSettings): void {
    this.db
      .prepare(`INSERT INTO thread_runtime_settings VALUES (?,?)
      ON CONFLICT(thread_id) DO UPDATE SET settings_json=excluded.settings_json`)
      .run(threadId, JSON.stringify(settings))
  }

  submittedTurn(threadId: string, messageId: string, hash: string): TurnRecord | null {
    const row = this.db
      .prepare('SELECT * FROM submissions WHERE thread_id=? AND message_id=?')
      .get(threadId, messageId)
    if (!row) return null
    if (row.payload_hash !== hash) throw new ProtocolError(-32009, '消息 ID 已被不同内容使用')
    const turn = this.getTurn(row.turn_id)
    if (!turn) throw new ProtocolError(-32009, '原提交已被回退，请使用新的消息 ID')
    return turn
  }

  saveSubmission(
    turn: TurnRecord,
    messageId: string | null,
    hash: string,
    queuedId?: string,
  ): void {
    // 记着的流式内容先写进去，不放进下面的事务里：事务回滚的话它们就跟着丢了
    this.flush(turn.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.upsertTurn(turn)
      if (messageId)
        this.db
          .prepare('INSERT INTO submissions VALUES (?,?,?,?)')
          .run(turn.threadId, messageId, hash, turn.id)
      if (queuedId) {
        const user = turn.items.find((item) => item.type === 'userMessage')
        if (!messageId || user?.type !== 'userMessage') throw new Error('队列回合缺少用户输入身份')
        this.queue.consume(turn.threadId, queuedId, messageId, user.content)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveSteeredMessage(
    turnId: string,
    item: ThreadItem,
    messageId: string | null,
    hash: string,
  ): void {
    const turn = this.getTurn(turnId)
    if (!turn) throw new ProtocolError(-32602, '未知 Turn')
    this.saveSubmission({ ...turn, items: [...turn.items, item] }, messageId, hash)
  }

  /** 插进回合的话没送进去（回合正在收尾、已经结束）：从回合里撤掉，同一个消息号的提交记录也删掉，重试不会当成已收下 */
  withdrawSteeredMessage(turnId: string, itemId: string, messageId: string | null): void {
    const turn = this.getTurn(turnId)
    if (!turn) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.upsertTurn({ ...turn, items: turn.items.filter((item) => item.id !== itemId) })
      if (messageId)
        this.db
          .prepare('DELETE FROM submissions WHERE thread_id=? AND message_id=? AND turn_id=?')
          .run(turn.threadId, messageId, turn.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveNativeBoundary(turnId: string, messageId: string): void {
    this.db
      .prepare(`INSERT INTO native_turn_boundaries VALUES (?,?)
      ON CONFLICT(turn_id) DO UPDATE SET message_id=excluded.message_id`)
      .run(turnId, messageId)
  }

  nativeBoundary(turnId: string): string | null {
    return (
      this.db.prepare('SELECT message_id FROM native_turn_boundaries WHERE turn_id=?').get(turnId)
        ?.message_id ?? null
    )
  }

  beginContextInjection(context: ContextInjection, turnId: string | null): void {
    if (this.pendingContextInjection(context.threadId))
      throw new ProtocolError(-32009, '已有待确认的原生上下文追加')
    this.db
      .prepare('INSERT INTO context_injections VALUES (?,?,?,?,0)')
      .run(context.messageId, context.threadId, turnId, JSON.stringify(context))
  }

  pendingContextInjection(threadId: string): ContextInjection | null {
    const row = this.db
      .prepare('SELECT context_json FROM context_injections WHERE thread_id=? AND committed=0')
      .get(threadId)
    return row ? (JSON.parse(row.context_json) as ContextInjection) : null
  }

  discardContextInjection(messageId: string): void {
    this.db
      .prepare('DELETE FROM context_injections WHERE message_id=? AND committed=0')
      .run(messageId)
  }

  // 原生追加先确认落盘，再原子提交 session 指针、回退边界和 journal；不制造聊天 Turn。
  commitContextInjection(context: ContextInjection, boundary: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT turn_id FROM context_injections WHERE message_id=? AND committed=0')
        .get(context.messageId)
      const thread = this.getThread(context.threadId)
      if (!row || !thread) throw new ProtocolError(-32000, '上下文追加持久状态不完整')
      thread.claudeSessionId = context.sessionId
      thread.updatedAt = nowSeconds()
      this.upsertThread(thread)
      if (row.turn_id) this.saveNativeBoundary(row.turn_id, boundary)
      this.db
        .prepare('UPDATE context_injections SET committed=1 WHERE message_id=?')
        .run(context.messageId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteThread(threadId: string): void {
    this.flushAll()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('DELETE FROM hook_runs WHERE turn_id IN (SELECT id FROM turns WHERE thread_id=?)')
        .run(threadId)
      this.db
        .prepare(
          'DELETE FROM native_turn_boundaries WHERE turn_id IN (SELECT id FROM turns WHERE thread_id=?)',
        )
        .run(threadId)
      this.db
        .prepare(
          'DELETE FROM turn_origins WHERE turn_id IN (SELECT id FROM turns WHERE thread_id=?)',
        )
        .run(threadId)
      for (const table of [
        'context_injections',
        'turns',
        'submissions',
        'thread_runtime_settings',
        'tool_executions',
        'native_tool_intents',
        'thread_goals',
        'goal_ledgers',
        'thread_usage',
        'thread_attachments',
        'queued_submissions',
        'project_threads',
        'live_project_threads',
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId)
      this.db.prepare('DELETE FROM threads WHERE id=?').run(threadId)
      // 导进来的原生会话被删了：原生记录不动（它可能还在命令行、Claude 桌面端里用着），只是不再导进来
      this.db
        .prepare(
          "UPDATE native_sessions SET origin='dismissed' WHERE thread_id=? AND origin='imported'",
        )
        .run(threadId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Used by thread/rollback to drop the N most recent turns from a thread's
  // history. Codex App's rewind UI calls this when the user wants to redo a
  // turn — without it our handler used to no-op and the App's "Rewind" button
  // appeared dead. Returns the number of turns actually removed.
  deleteRecentTurns(threadId: string, numTurns: number): number {
    if (numTurns <= 0) return 0
    this.flushAll()
    const ids = this.db
      .prepare(
        'SELECT id FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
      )
      .all(threadId, numTurns) as Array<{ id: string }>
    if (ids.length === 0) return 0
    const stmt = this.db.prepare('DELETE FROM turns WHERE id = ?')
    for (const row of ids) {
      this.db.prepare('DELETE FROM hook_runs WHERE turn_id=?').run(row.id)
      this.db.prepare('DELETE FROM native_turn_boundaries WHERE turn_id=?').run(row.id)
      // 回退掉的回合不再在模型的上下文里，它的工具意图也不用再核对、再告诉模型
      this.db.prepare('DELETE FROM native_tool_intents WHERE turn_id=?').run(row.id)
      stmt.run(row.id)
    }
    return ids.length
  }

  // 原生分叉成功后一次提交 session 指针及展示历史。崩溃最多留下未引用的原生分支。
  // truncated：切在回合中间时被切开的那一回合（只留前半段）和切掉的条目。
  // 切掉的插话的提交记录跟着删，它们的工具意图也不用再核对（和整回合退掉一样）
  commitRollback(
    thread: ThreadRecord,
    numTurns: number,
    boundaries: ReadonlyMap<string, string>,
    truncated?: { turn: TurnRecord; removed: readonly ThreadItem[] },
  ): number {
    this.flushAll()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.upsertThread(thread)
      const dropped = this.deleteRecentTurns(thread.id, numTurns)
      if (truncated) {
        this.writeTurn(truncated.turn)
        for (const item of truncated.removed) {
          if (item.type === 'userMessage' && item.clientId)
            this.db
              .prepare('DELETE FROM submissions WHERE thread_id=? AND message_id=? AND turn_id=?')
              .run(thread.id, item.clientId, truncated.turn.id)
          this.db
            .prepare('DELETE FROM native_tool_intents WHERE turn_id=? AND call_id=?')
            .run(truncated.turn.id, item.id)
        }
      }
      for (const [turnId, messageId] of boundaries) this.saveNativeBoundary(turnId, messageId)
      this.db.exec('COMMIT')
      return dropped
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 回合里多了一个条目。条目的增减（工具调用的开始和结束、命令、文件改动、钩子）一个回合里可以有成百上千次，
   * 每次都把整个回合读出来、解析、序列化、整行写回去的话，回合越长每次越贵，整个回合就是平方级的。
   * 所以只在 turn_item_log 里记一行（只有这一个条目），内存里留着合起来的样子（liveTurn），
   * 回合被读、被整行写、结束时才合进 turns 那一行（flush）。记下的每一笔当场就在库里，
   * 进程被强杀之后，下次打开库时合进去（mergeLeftoverChanges），所以条目的增减不比从前少存。
   */
  appendItem(turnId: string, item: ThreadItem): void {
    this.settle(turnId)
    const live = this.liveTurn(turnId)
    if (live) this.logChange(turnId, live, 'add', live.items.length, item)
    this.flushIfFinished(turnId)
  }

  /** 改一个条目（同上，只记这一个条目）。返回改完的样子（就是 updater 给的那个），没有这个条目时是 null */
  updateItem(
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem,
  ): ThreadItem | null {
    this.settle(turnId)
    const live = this.liveTurn(turnId)
    if (!live) return null
    let first: ThreadItem | null = null
    for (let index = 0; index < live.items.length; index++) {
      const current = live.items[index]
      if (current?.id !== itemId) continue
      const updated = updater(jsonClone(current))
      this.logChange(turnId, live, 'set', index, updated)
      first ??= updated
    }
    this.flushIfFinished(turnId)
    return first
  }

  updateItemAndMoveToEnd(
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem,
  ): void {
    this.settle(turnId)
    const live = this.liveTurn(turnId)
    if (!live) return
    const index = live.items.findIndex((item) => item.id === itemId)
    const current = live.items[index]
    if (index < 0 || !current) return
    this.logChange(turnId, live, 'move', index, updater(jsonClone(current)))
    this.flushIfFinished(turnId)
  }

  /** 回合里的一个条目（拷贝一份），不读整个回合。没有时是 null */
  getItem(turnId: string, itemId: string): ThreadItem | null {
    this.settle(turnId)
    const item = this.liveTurn(turnId)?.items.find((entry) => entry.id === itemId)
    this.flushIfFinished(turnId)
    return item ? jsonClone(item) : null
  }

  /**
   * 回合已经结束了的条目改动（打断之后收尾、后台命令跑完）没几次，改完当场合进去：
   * 内存里只留还在跑的回合，结束了的不在这儿一直占着
   */
  private flushIfFinished(turnId: string): void {
    if (this.live.has(turnId) && this.turnStatus(turnId) !== 'inProgress') this.flush(turnId)
  }

  recordHookEvent(
    turnId: string,
    event: HookEvent,
  ): { item: ThreadItem; started: boolean; completed: boolean } | null {
    const row = this.db
      .prepare('SELECT run_json FROM hook_runs WHERE turn_id=? AND hook_id=?')
      .get(turnId, event.hookRunId) as { run_json: string } | undefined
    const previous: HookRun | null = row ? JSON.parse(row.run_json) : null
    if (
      previous?.outcome ||
      (previous && event.phase === 'started') ||
      (event.messageId && previous?.messageIds.includes(event.messageId))
    )
      return null
    const run: HookRun = {
      itemId: previous?.itemId ?? newId(),
      hookRunId: event.hookRunId,
      hookName: event.hookName,
      hookEvent: event.hookEvent,
      phase: event.phase,
      outcome: event.phase === 'response' ? (event.outcome ?? 'unknown') : null,
      exitCode: event.exitCode,
      stdout: event.stdout,
      stderr: event.stderr,
      output: event.output,
      messageIds: [...(previous?.messageIds ?? []), ...(event.messageId ? [event.messageId] : [])],
      explanation:
        !previous && event.phase !== 'started'
          ? '未收到此 Hook 的开始事件'
          : (previous?.explanation ?? null),
    }
    const item = hookItem(run)
    // 记着的流式内容先记进去，不放进下面的事务里：事务回滚的话它们就跟着丢了
    this.settle(turnId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'INSERT INTO hook_runs(turn_id,hook_id,run_json) VALUES(?,?,?) ON CONFLICT(turn_id,hook_id) DO UPDATE SET run_json=excluded.run_json',
        )
        .run(turnId, run.hookRunId, JSON.stringify(run))
      if (previous) this.updateItem(turnId, item.id, () => item)
      else this.appendItem(turnId, item)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      // 内存里那一份已经带上了回滚掉的改动，扔掉，下次照库里的重新合
      this.live.delete(turnId)
      throw error
    }
    return { item, started: !previous, completed: event.phase === 'response' }
  }

  finishHookRuns(
    turnId: string,
    outcome: 'unknown' | 'cancelled',
    explanation: string,
  ): ThreadItem[] {
    const rows = this.db
      .prepare('SELECT run_json FROM hook_runs WHERE turn_id=?')
      .all(turnId) as Array<{ run_json: string }>
    const items: ThreadItem[] = []
    for (const row of rows) {
      const run: HookRun = JSON.parse(row.run_json)
      if (run.outcome) continue
      run.outcome = outcome
      run.explanation = explanation
      const item = hookItem(run)
      this.settle(turnId)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .prepare('UPDATE hook_runs SET run_json=? WHERE turn_id=? AND hook_id=?')
          .run(JSON.stringify(run), turnId, run.hookRunId)
        this.updateItem(turnId, item.id, () => item)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        this.live.delete(turnId)
        throw error
      }
      items.push(item)
    }
    return items
  }

  completeTurn(
    turnId: string,
    status: TurnStatus,
    error: unknown | null = null,
  ): TurnRecord | null {
    this.finishHookRuns(
      turnId,
      status === 'interrupted' ? 'cancelled' : 'unknown',
      '回合已结束，未收到原生 Hook 终态；不能确认执行结果或自动重放',
    )
    const turn = this.getTurn(turnId)
    if (!turn) return null
    const completedAt = nowSeconds()
    turn.status = status
    turn.completedAt = completedAt
    turn.durationMs =
      turn.startedAt == null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000)
    turn.error = error
    this.upsertTurn(turn)
    return turn
  }

  recoverStaleInProgressTurns(message = 'server restarted before completing turn'): number {
    this.flushAll()
    const hooks = this.db.prepare('SELECT DISTINCT turn_id FROM hook_runs').all() as Array<{
      turn_id: string
    }>
    for (const hook of hooks)
      this.finishHookRuns(
        hook.turn_id,
        'unknown',
        '适配器已重启，未收到原生 Hook 终态；执行结果不确定，不自动重放',
      )
    const rows = this.db
      .prepare('SELECT id, thread_id, started_at, items_json FROM turns WHERE status = ?')
      .all('inProgress') as Array<{
      id: string
      thread_id: string
      started_at: number | null
      items_json: string
    }>
    const completedAt = nowSeconds()
    const errorJson = JSON.stringify({ message })
    const updateTurn = this.db.prepare(`
      UPDATE turns
      SET status = ?, completed_at = ?, duration_ms = ?, error_json = ?, items_json = ?
      WHERE id = ?
    `)
    const updateThread = this.db.prepare(
      'UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?',
    )
    const seenThreads = new Set<string>()
    let recoveredCount = 0
    for (const row of rows) {
      const startedAt = row.started_at == null ? null : Number(row.started_at)
      const durationMs = startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1000)
      updateTurn.run(
        'interrupted',
        completedAt,
        durationMs,
        errorJson,
        this.terminalizeStaleItems(
          row.items_json,
          message,
          true,
          false,
          this.uncertainToolIds(row.thread_id),
        ),
        row.id,
      )
      seenThreads.add(String(row.thread_id))
      recoveredCount += 1
    }
    for (const threadId of seenThreads) {
      updateThread.run(JSON.stringify({ type: 'idle' }), completedAt, threadId)
    }
    const terminalRows = this.db
      .prepare('SELECT id, thread_id, status, items_json FROM turns WHERE status <> ?')
      .all('inProgress') as Array<{
      id: string
      thread_id: string
      status: TurnStatus
      items_json: string
    }>
    const updateItems = this.db.prepare('UPDATE turns SET items_json = ? WHERE id = ?')
    const repairThreadIds = new Set<string>()
    for (const row of terminalRows) {
      // A successful legacy Codex cc turn may contain only a
      // `subAgentActivity: started` marker. Remove that optional marker during
      // recovery so the canonical spawnAgent/wait terminal state is used and
      // a cold-opened child cannot be revived as working.
      const itemsJson = this.terminalizeStaleItems(
        row.items_json,
        message,
        row.status !== 'completed',
        row.status === 'completed',
        this.uncertainToolIds(row.thread_id),
        row.status,
      )
      if (itemsJson === row.items_json) continue
      updateItems.run(itemsJson, row.id)
      repairThreadIds.add(String(row.thread_id))
      recoveredCount += 1
    }
    const reconcileThread = this.db.prepare(
      `UPDATE threads SET status_json = ?, updated_at = ?
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM turns WHERE thread_id = threads.id AND status = ?)`,
    )
    for (const threadId of repairThreadIds) {
      reconcileThread.run(JSON.stringify({ type: 'idle' }), completedAt, threadId, 'inProgress')
    }
    // A crash can land between completeTurn() and the following
    // setThreadStatus(..., idle). In that window every turn is already
    // terminal, so the item JSON is unchanged and the repairThreadIds path
    // above has nothing to trigger. Reconcile those active threads directly;
    // never touch a thread that still owns an in-progress turn.
    const reconcileTerminalActiveThreads = this.db.prepare(
      `UPDATE threads SET status_json = ?, updated_at = ?
       WHERE json_extract(status_json, '$.type') = 'active'
         AND NOT EXISTS (SELECT 1 FROM turns WHERE thread_id = threads.id AND status = ?)`,
    )
    const reconciled = reconcileTerminalActiveThreads.run(
      JSON.stringify({ type: 'idle' }),
      completedAt,
      'inProgress',
    ) as { changes?: number }
    recoveredCount += Number(reconciled.changes ?? 0)
    return recoveredCount
  }

  // A recovered turn is also replayed from its persisted item list. Clear any
  // item-level liveness markers so the App's spinner projection cannot keep a
  // child agent in `working` after the turn/thread has been terminalized.
  private uncertainToolIds(threadId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT call_id FROM tool_executions WHERE thread_id=? AND result_json IS NULL')
      .all(threadId) as Array<{ call_id: string }>
    return new Set(rows.map((row) => String(row.call_id)))
  }

  private terminalizeStaleItems(
    itemsJson: string,
    message: string,
    terminalizeActivity = true,
    stripCompletedActivity = false,
    uncertainCallIds: ReadonlySet<string> = new Set(),
    reviewStatus: TurnStatus = 'interrupted',
  ): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(itemsJson)
    } catch {
      return '[]'
    }
    if (!Array.isArray(parsed)) return '[]'

    const items = parsed
      .map((raw) => {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const item = raw as Record<string, unknown>
        if (
          item.type === 'dynamicToolCall' &&
          item.status === 'inProgress' &&
          uncertainCallIds.has(String(item.id))
        ) {
          // 失败的是结果确认，副作用可能已经发生；保留 success=null，禁止补造结果。
          return {
            ...item,
            status: 'failed',
            success: null,
            contentItems: [
              {
                type: 'inputText',
                text: '工具执行结果不确定：进程在确认结果前退出，可能已经产生副作用。禁止自动重放，请核对执行器状态。',
              },
            ],
          }
        }
        if (stripCompletedActivity && item.type === 'subAgentActivity') return null
        if (
          terminalizeActivity &&
          item.type === 'subAgentActivity' &&
          (item.kind === 'started' || item.kind === 'interacted')
        ) {
          return { ...item, kind: 'interrupted' }
        }
        // Older adapter builds persisted the newer `completed` activity kind,
        // which Codex cc 26.x cannot deserialize. `interrupted` is the legacy
        // terminal marker understood by the App reducer and prevents a cold
        // open from reviving the child as working.
        if (item.type === 'subAgentActivity' && item.kind === 'completed') {
          return { ...item, kind: 'interrupted' }
        }
        if (item.type === 'collabAgentToolCall') {
          const agentsStates = item.agentsStates
          const nextStates =
            agentsStates && typeof agentsStates === 'object' && !Array.isArray(agentsStates)
              ? Object.fromEntries(
                  Object.entries(agentsStates as Record<string, unknown>).map(
                    ([threadId, rawState]) => {
                      if (
                        rawState == null ||
                        typeof rawState !== 'object' ||
                        Array.isArray(rawState)
                      )
                        return [threadId, rawState]
                      const state = rawState as Record<string, unknown>
                      if (state.status !== 'pendingInit' && state.status !== 'running')
                        return [threadId, state]
                      return [
                        threadId,
                        { ...state, status: 'errored', message: state.message ?? message },
                      ]
                    },
                  ),
                )
              : agentsStates
          return {
            ...item,
            ...(item.status === 'inProgress' ? { status: 'failed' } : {}),
            agentsStates: nextStates,
          }
        }
        if (item.status === 'inProgress') return { ...item, status: 'failed' }
        return item
      })
      .filter((item) => item != null)
    // 崩溃时无法发出退出事件；恢复只补持久化终止标记，不补造模型结论。
    // 已有退出标记保持原 ID，重复启动不能创建第二条退出记录。
    if (
      reviewStatus !== 'completed' &&
      items.some((item) => item.type === 'enteredReviewMode') &&
      !items.some((item) => item.type === 'exitedReviewMode')
    )
      items.push({
        type: 'exitedReviewMode',
        id: newId(),
        review:
          reviewStatus === 'failed'
            ? '审查失败，未完成；运行时恢复时未记录完整审查结论。'
            : '审查已中断，未完成；运行时恢复时未记录完整审查结论。',
      })
    return JSON.stringify(items)
  }

  /** 回合的差异换成新的：只写这一列（条目在内存里那一份不带它，合进去时也不碰它） */
  updateTurnDiff(turnId: string, diff: string): void {
    this.settle(turnId)
    this.db.prepare('UPDATE turns SET diff = ? WHERE id = ?').run(diff, turnId)
  }

  close(): void {
    this.flushAll()
    this.db.close()
  }

  private rowToThread(row: any): ThreadRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      forkedFromId: row.forked_from_id == null ? null : String(row.forked_from_id),
      isPinned:
        String(row.section_id ?? '') === PINNED_SECTION_ID || Number(row.is_pinned ?? 0) === 1,
      sectionId: row.section_id == null ? null : String(row.section_id),
      sectionEnteredAt: row.section_entered_at == null ? null : Number(row.section_entered_at),
      sectionPosition: row.section_position == null ? null : Number(row.section_position),
      preview: String(row.preview ?? ''),
      name: row.name == null ? null : String(row.name),
      archived: Number(row.archived) === 1,
      cwd: String(row.cwd),
      model: String(row.model),
      reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
      modelProvider: String(row.model_provider),
      claudeSessionId: row.claude_session_id == null ? null : String(row.claude_session_id),
      source: String(row.source),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      status: JSON.parse(String(row.status_json)),
      approvalPolicy: normalizeApprovalPolicy(
        typeof row.approval_policy === 'string' && row.approval_policy.startsWith('{')
          ? JSON.parse(row.approval_policy)
          : row.approval_policy,
      ),
      sandboxMode: row.sandbox_mode == null ? null : String(row.sandbox_mode),
      permissionProfileId:
        row.permission_profile_id == null ? null : String(row.permission_profile_id),
      ephemeral: Number(row.ephemeral ?? 0) === 1,
      threadSource: row.thread_source == null ? null : String(row.thread_source),
      agentRole: row.agent_role == null ? null : String(row.agent_role),
      agentNickname: row.agent_nickname == null ? null : String(row.agent_nickname),
      baseInstructions: row.base_instructions == null ? null : String(row.base_instructions),
      developerInstructions:
        row.developer_instructions == null ? null : String(row.developer_instructions),
      personality: row.personality == null ? null : String(row.personality),
      runtimeBackend: row.runtime_backend === 'codex' ? 'codex' : 'claude',
      codexSessionId: row.codex_session_id == null ? null : String(row.codex_session_id),
    }
  }

  private rowToSection(row: any): ThreadSectionRecord {
    let appearance: ThreadSectionAppearance | null = null
    if (row.appearance_json != null) {
      try {
        const parsed: unknown = JSON.parse(String(row.appearance_json))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const value = parsed as Record<string, unknown>
          appearance = {
            color: typeof value.color === 'string' ? value.color : null,
            icon: typeof value.icon === 'string' ? value.icon : null,
          }
        }
      } catch {}
    }
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      appearance,
    }
  }

  private rowToTurn(row: any): TurnRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      status: String(row.status) as TurnStatus,
      startedAt: row.started_at == null ? null : Number(row.started_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      items: JSON.parse(String(row.items_json)),
      diff: String(row.diff ?? ''),
      error: row.error_json == null ? null : JSON.parse(String(row.error_json)),
    }
  }
}
