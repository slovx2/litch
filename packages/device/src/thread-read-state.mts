import type { DatabaseSync } from 'node:sqlite'
import { THREAD_READ_BATCH, type ThreadReadState } from '../../protocol/src/thread-read-state.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { isObject } from './wire.mjs'

/** 完成事件可能同时来自多个连接；唯一键落盘，重连或进程重启也不会重复计数。 */
export class ThreadReadStates {
  private readonly db: DatabaseSync
  private readonly index: ThreadIndex
  private readonly announce: (state: ThreadReadState) => void
  private readonly running = new Map<string, number>()
  private closed = false
  /** 没订阅正文的连接可能只有状态广播；只补读最近一页，不加载整份历史。 */
  latest: ((harness: string, threadId: string) => Promise<unknown>) | null = null
  follow: (threadId: string) => void = () => {}
  log: (message: string) => void = () => {}

  close(): void {
    this.closed = true
    this.running.clear()
  }

  constructor(db: DatabaseSync, index: ThreadIndex, announce: (state: ThreadReadState) => void) {
    this.db = db
    this.index = index
    this.announce = announce
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_completed_turns(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        UNIQUE(thread_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS thread_completed_latest
        ON thread_completed_turns(thread_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS thread_read_cursors(
        thread_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS thread_read_delete AFTER DELETE ON threads BEGIN
        DELETE FROM thread_completed_turns WHERE thread_id=OLD.id;
        DELETE FROM thread_read_cursors WHERE thread_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS thread_read_archive AFTER UPDATE OF archived ON threads
      WHEN NEW.archived=1 BEGIN
        INSERT INTO thread_read_cursors(thread_id, sequence)
          VALUES(NEW.id, COALESCE((SELECT MAX(sequence) FROM thread_completed_turns WHERE thread_id=NEW.id), 0))
          ON CONFLICT(thread_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence);
      END;
      DELETE FROM thread_completed_turns WHERE thread_id NOT IN (SELECT id FROM threads);
      DELETE FROM thread_read_cursors WHERE thread_id NOT IN (SELECT id FROM threads);
    `)
  }

  get(threadId: string): ThreadReadState {
    const last = this.db
      .prepare(
        'SELECT sequence,turn_id FROM thread_completed_turns WHERE thread_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(threadId)
    const read = this.db
      .prepare('SELECT sequence FROM thread_read_cursors WHERE thread_id=?')
      .get(threadId)
    return {
      threadId,
      turnId: last ? String(last.turn_id) : null,
      completedSequence: Number(last?.sequence ?? 0),
      readSequence: Number(read?.sequence ?? 0),
    }
  }

  list(params: unknown): { states: ThreadReadState[] } {
    if (
      !isObject(params) ||
      !Array.isArray(params.threadIds) ||
      params.threadIds.length > THREAD_READ_BATCH ||
      params.threadIds.some((id) => typeof id !== 'string' || !id || id.length > 1024)
    )
      throw new ProtocolError(-32602, `threadIds 必须是最多 ${THREAD_READ_BATCH} 项的会话标识数组`)
    return { states: [...new Set(params.threadIds as string[])].map((id) => this.get(id)) }
  }

  mark(params: unknown): ThreadReadState {
    if (
      !isObject(params) ||
      typeof params.threadId !== 'string' ||
      !params.threadId ||
      !Number.isSafeInteger(params.completedSequence) ||
      Number(params.completedSequence) < 0
    )
      throw new ProtocolError(-32602, '需要 threadId 和非负安全整数 completedSequence')
    const { threadId } = params
    const sequence = Number(params.completedSequence)
    const before = this.get(threadId)
    // 序号属于整个设备，不能接受另一会话的序号，也不能接受尚未完成的序号。
    if (
      sequence !== 0 &&
      !this.db
        .prepare('SELECT 1 FROM thread_completed_turns WHERE thread_id=? AND sequence=?')
        .get(threadId, sequence)
    )
      throw new ProtocolError(-32602, 'completedSequence 不属于该会话的完成回合')
    if (sequence > before.readSequence) {
      this.db
        .prepare(`INSERT INTO thread_read_cursors(thread_id,sequence) VALUES(?,?)
        ON CONFLICT(thread_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`)
        .run(threadId, sequence)
      const state = this.get(threadId)
      this.announce(state)
      return state
    }
    return before
  }

  observe(harness: string, method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    const thread = isObject(params.thread) ? params.thread : null
    if (thread && typeof thread.id === 'string') {
      this.index.see(thread as { id: string }, harness)
      if (thread.ephemeral !== true && isObject(thread.status) && thread.status.type === 'active')
        this.observe(harness, 'thread/status/changed', {
          threadId: thread.id,
          status: thread.status,
        })
      return
    }
    const threadId = params.threadId
    if (typeof threadId !== 'string') return
    if (
      method === 'turn/started' ||
      (method === 'thread/status/changed' &&
        isObject(params.status) &&
        params.status.type === 'active')
    ) {
      if (!this.running.has(threadId)) {
        this.running.set(threadId, this.get(threadId).completedSequence)
        // 沿用设备编排的订阅生命周期，客户端都断开后仍能看到回合结束。
        if (!this.db.prepare('SELECT 1 FROM threads WHERE id=? AND ephemeral=1').get(threadId))
          this.follow(threadId)
      }
      return
    }
    if (method === 'thread/status/changed' && isObject(params.status)) {
      const before = this.running.get(threadId)
      this.running.delete(threadId)
      if (before !== undefined)
        setImmediate(() => {
          if (this.closed || !this.latest || this.get(threadId).completedSequence !== before) return
          void this.latest(harness, threadId)
            .then((response) => {
              if (
                this.closed ||
                !this.index.lookup(threadId) ||
                this.get(threadId).completedSequence !== before
              )
                return
              const turns = isObject(response) && Array.isArray(response.data) ? response.data : []
              // 降序页中可能已有下一回合在运行；只认真实的完成回合，状态变化本身不造游标。
              const turn = turns.find(
                (one) =>
                  isObject(one) &&
                  ['completed', 'failed', 'interrupted'].includes(String(one.status)),
              )
              if (turn) this.observe(harness, 'turn/completed', { threadId, turn })
            })
            .catch((error: unknown) => this.log(`补取完成回合失败：${String(error)}`))
        })
      return
    }
    if (method === 'thread/deleted') {
      this.running.delete(threadId)
      this.index.forget(threadId)
      return
    }
    if (method === 'thread/archived') {
      this.index.setArchived(threadId, true)
      this.announce(this.get(threadId))
      return
    }
    if (method !== 'turn/completed' || !isObject(params.turn)) return
    const turn = params.turn
    if (
      typeof turn.id !== 'string' ||
      !['completed', 'failed', 'interrupted'].includes(String(turn.status))
    )
      return
    if (this.db.prepare('SELECT 1 FROM threads WHERE id=? AND ephemeral=1').get(threadId)) return
    if (!this.index.lookup(threadId)) this.index.see({ id: threadId }, harness)
    this.db.exec('BEGIN IMMEDIATE')
    let added = false
    try {
      added =
        this.db
          .prepare('INSERT OR IGNORE INTO thread_completed_turns(thread_id,turn_id) VALUES(?,?)')
          .run(threadId, turn.id).changes > 0
      if (added && this.index.archived(threadId)) {
        const state = this.get(threadId)
        this.db
          .prepare(`INSERT INTO thread_read_cursors(thread_id,sequence) VALUES(?,?)
          ON CONFLICT(thread_id) DO UPDATE SET sequence=excluded.sequence`)
          .run(threadId, state.completedSequence)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (added) {
      this.running.delete(threadId)
      this.announce(this.get(threadId))
    }
  }
}
