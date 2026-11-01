// 登记和投递凭据与会话树共用 sessions.sqlite；迁移由 openSessionDatabase 统一执行。
import type { DatabaseSync } from 'node:sqlite'
import type { NativeBackgroundState } from '../../protocol/src/native-background-wake.mjs'

export interface NativeBackgroundTask {
  id: string
  harness: string
  threadId: string
  itemId: string
  turnId: string
  processId: string
  title: string
  purpose: string
  command: string
  startedAt: number
  endedAt?: number
  exitCode: number | null
  output: string
  truncated: boolean
  state: NativeBackgroundState
  batchId?: string
}

export class NativeBackgroundStore {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(threadId: string): NativeBackgroundTask[] {
    return this.db
      .prepare('SELECT body FROM native_background_tasks WHERE thread_id = ? ORDER BY rowid')
      .all(threadId)
      .map((row) => JSON.parse(String(row.body)) as NativeBackgroundTask)
  }

  save(task: NativeBackgroundTask): void {
    this.db
      .prepare(
        'INSERT INTO native_background_tasks(id, thread_id, body) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(task.id, task.threadId, JSON.stringify(task))
  }

  prune(threadId: string): string[] {
    const ended = this.list(threadId).filter((task) =>
      ['delivered', 'cancelled', 'lost'].includes(task.state),
    )
    const removed = ended.slice(0, Math.max(0, ended.length - 50)).map((task) => task.id)
    const erase = this.db.prepare('DELETE FROM native_background_tasks WHERE id=?')
    for (const id of removed) erase.run(id)
    return removed
  }

  // 重启后保留可读结果，绝不把旧 pending 或旧进程登记重新加入自动投递队列。
  recover(): void {
    const rows = this.db.prepare('SELECT body FROM native_background_tasks').all()
    for (const row of rows) {
      const task = JSON.parse(String(row.body)) as NativeBackgroundTask
      if (['watching', 'pending', 'paused', 'unknown'].includes(task.state)) {
        task.state = task.endedAt === undefined ? 'lost' : 'cancelled'
        this.save(task)
      }
    }
  }

  rememberTurn(threadId: string, turnId: string, batchId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO native_background_turns(thread_id, turn_id, batch_id) VALUES(?, ?, ?)',
      )
      .run(threadId, turnId, batchId)
  }

  isWake(threadId: string, turnId: string): boolean {
    if (!threadId)
      return !!this.db.prepare('SELECT 1 FROM native_background_turns WHERE turn_id=?').get(turnId)
    return !!this.db
      .prepare('SELECT 1 FROM native_background_turns WHERE thread_id=? AND turn_id=?')
      .get(threadId, turnId)
  }

  userTurn(threadId: string, turnId: string): void {
    this.db
      .prepare('DELETE FROM native_background_turns WHERE thread_id=? AND turn_id=?')
      .run(threadId, turnId)
  }

  forget(threadId: string): void {
    this.db.prepare('DELETE FROM native_background_tasks WHERE thread_id=?').run(threadId)
    this.db.prepare('DELETE FROM native_background_turns WHERE thread_id=?').run(threadId)
  }
}
