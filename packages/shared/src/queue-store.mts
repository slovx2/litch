import type { DatabaseSync } from 'node:sqlite'
import { ProtocolError, submissionHash } from './protocol-contract.mjs'
import type { UserInput } from './types.mjs'
import { newId } from './util.mjs'

export type QueuedSubmission = { id: string; clientUserMessageId: string; input: UserInput[] }

export class QueueStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS queued_submissions (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL,
      input_json TEXT NOT NULL, admission_hash TEXT NOT NULL, position INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','consumed','deleted')),
      UNIQUE(thread_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_pending ON queued_submissions(thread_id,state,position);`)
  }

  private decode(row: Record<string, unknown>): QueuedSubmission {
    return {
      id: String(row.id),
      clientUserMessageId: String(row.client_id),
      input: JSON.parse(String(row.input_json)),
    }
  }

  list(threadId: string): QueuedSubmission[] {
    return this.db
      .prepare(
        "SELECT * FROM queued_submissions WHERE thread_id=? AND state='queued' ORDER BY position,id",
      )
      .all(threadId)
      .map((row) => this.decode(row))
  }

  get(threadId: string, id: string): QueuedSubmission | null {
    const row = this.db
      .prepare("SELECT * FROM queued_submissions WHERE thread_id=? AND id=? AND state='queued'")
      .get(threadId, id)
    return row ? this.decode(row) : null
  }

  hasClient(threadId: string, clientId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM queued_submissions WHERE thread_id=? AND client_id=?')
      .get(threadId, clientId)
  }

  add(
    threadId: string,
    clientId: string,
    input: UserInput[],
  ): { item: QueuedSubmission; created: boolean } {
    const hash = submissionHash(input)
    const existing = this.db
      .prepare('SELECT * FROM queued_submissions WHERE thread_id=? AND client_id=?')
      .get(threadId, clientId)
    if (existing) {
      if (existing.admission_hash !== hash)
        throw new ProtocolError(-32009, '队列消息 ID 已被不同输入使用')
      if (existing.state !== 'queued')
        throw new ProtocolError(-32009, '队列消息已执行或删除，不能重新入队')
      return { item: this.decode(existing), created: false }
    }
    if (
      this.db
        .prepare('SELECT 1 FROM submissions WHERE thread_id=? AND message_id=?')
        .get(threadId, clientId)
    )
      throw new ProtocolError(-32009, '消息 ID 已提交，不能重新入队')
    const item = { id: newId(), clientUserMessageId: clientId, input }
    this.db
      .prepare(`INSERT INTO queued_submissions
      (id,thread_id,client_id,input_json,admission_hash,position,state)
      SELECT ?,?,?,?,?,COALESCE(MAX(position),0)+1,'queued' FROM queued_submissions WHERE thread_id=?`)
      .run(item.id, threadId, clientId, JSON.stringify(input), hash, threadId)
    return { item, created: true }
  }

  update(threadId: string, id: string, input: UserInput[]): QueuedSubmission {
    const item = this.get(threadId, id)
    if (!item) throw new ProtocolError(-32602, '待执行队列项不存在')
    this.db
      .prepare(
        "UPDATE queued_submissions SET input_json=? WHERE thread_id=? AND id=? AND state='queued'",
      )
      .run(JSON.stringify(input), threadId, id)
    return { ...item, input }
  }

  delete(threadId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE queued_submissions SET state='deleted' WHERE thread_id=? AND id=? AND state='queued'",
        )
        .run(threadId, id).changes > 0
    )
  }

  reorder(threadId: string, ids: string[]): void {
    const pending = this.list(threadId)
    if (
      ids.length !== pending.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !pending.some((item) => item.id === id))
    )
      throw new ProtocolError(-32602, '重排必须恰好包含全部待执行队列项')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.db.prepare(
        "UPDATE queued_submissions SET position=? WHERE thread_id=? AND id=? AND state='queued'",
      )
      ids.forEach((id, index) => {
        update.run(index, threadId, id)
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // 只能在 SessionStore.saveSubmission 的事务中调用，领取与回合/去重账本同生共死。
  consume(threadId: string, id: string, clientId: string, input: UserInput[]): void {
    const item = this.get(threadId, id)
    if (
      !item ||
      item.clientUserMessageId !== clientId ||
      submissionHash(item.input) !== submissionHash(input)
    )
      throw new ProtocolError(-32009, '待执行队列项已改变')
    this.db
      .prepare(
        "UPDATE queued_submissions SET state='consumed' WHERE thread_id=? AND id=? AND state='queued'",
      )
      .run(threadId, id)
  }
}
