import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface RestartTurn {
  threadId: string
  harness: string
  token: string
  turnId: string | null
  state: string
  service: string
  preparedAt: number | null
  background: string[]
}

/** 普通输入的身份与明确重启的票分开：observed 在意外重启后绝不自动执行。 */
export class RestartStore {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }

  input(harness: string, threadId: string): string {
    const token = randomUUID()
    this.db
      .prepare(`INSERT INTO restart_turns(thread_id,harness,token,state)
      VALUES(?,?,?,'observed') ON CONFLICT(thread_id) DO UPDATE SET
      harness=excluded.harness,token=excluded.token,turn_id=NULL,state='observed',
      service='',prepared_at=NULL,resume_turn_id=NULL,background='[]'`)
      .run(threadId, harness, token)
    return token
  }

  accepted(threadId: string, token: string, turnId: string): void {
    this.db
      .prepare(
        "UPDATE restart_turns SET turn_id=? WHERE thread_id=? AND token=? AND state='observed'",
      )
      .run(turnId, threadId, token)
  }

  cancel(threadId: string): void {
    this.db.prepare("UPDATE restart_turns SET state='cancelled' WHERE thread_id=?").run(threadId)
  }

  waiting(threadId: string): void {
    // 曾经问过且已经答复的普通回合仍可恢复；只撤销准备／待发期间新出现的待答。
    this.db
      .prepare(
        "UPDATE restart_turns SET state='cancelled' WHERE thread_id=? AND state IN ('preparing','ready')",
      )
      .run(threadId)
  }

  finished(threadId: string, turnId: string): void {
    this.db
      .prepare(
        "UPDATE restart_turns SET state='finished' WHERE thread_id=? AND state='observed' AND (turn_id=? OR turn_id IS NULL)",
      )
      .run(threadId, turnId)
  }

  rows(state: string): RestartTurn[] {
    return this.db
      .prepare('SELECT * FROM restart_turns WHERE state=?')
      .all(state)
      .map((row) => ({
        threadId: String(row.thread_id),
        harness: String(row.harness),
        token: String(row.token),
        turnId: typeof row.turn_id === 'string' ? row.turn_id : null,
        state: String(row.state),
        service: String(row.service),
        preparedAt: typeof row.prepared_at === 'number' ? row.prepared_at : null,
        background: JSON.parse(String(row.background)) as string[],
      }))
  }

  interrupting(threadId: string, turnId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM restart_turns WHERE thread_id=? AND turn_id=? AND state IN ('preparing','ready','dispatching','sent')",
        )
        .get(threadId, turnId),
    )
  }

  pending(threadId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM restart_turns WHERE thread_id=? AND state='ready'")
        .get(threadId),
    )
  }

  state(row: RestartTurn): string | null {
    const result = this.db
      .prepare('SELECT state FROM restart_turns WHERE thread_id=? AND token=?')
      .get(row.threadId, row.token)
    return typeof result?.state === 'string' ? result.state : null
  }

  move(row: RestartTurn, from: string, to: string): boolean {
    return (
      this.db
        .prepare('UPDATE restart_turns SET state=? WHERE thread_id=? AND token=? AND state=?')
        .run(to, row.threadId, row.token, from).changes === 1
    )
  }

  prepare(row: RestartTurn, service: string, now: number, background: string[] = []): boolean {
    return (
      this.db
        .prepare(`UPDATE restart_turns SET state='preparing',service=?,prepared_at=?,background=?
      WHERE thread_id=? AND token=? AND state='observed'`)
        .run(service, now, JSON.stringify(background), row.threadId, row.token).changes === 1
    )
  }

  sent(row: RestartTurn, turnId: string): void {
    this.db
      .prepare(
        "UPDATE restart_turns SET state='sent',resume_turn_id=? WHERE thread_id=? AND token=? AND state='dispatching'",
      )
      .run(turnId, row.threadId, row.token)
  }
}
