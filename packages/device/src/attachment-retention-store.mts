// 附件归属与清理墓碑独立保存；不改引擎历史，也不将记录写进待清理目录。
import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface AttachmentOwner {
  harness: string
  threadId: string
}
export const ownerKey = (owner: AttachmentOwner) => JSON.stringify([owner.harness, owner.threadId])

export class AttachmentRetentionStore {
  private db: DatabaseSync
  constructor(stateDir: string) {
    const path = join(stateDir, 'attachments.sqlite')
    if (!existsSync(path)) closeSync(openSync(path, 'ax', 0o600))
    this.db = new DatabaseSync(path)
    this.db.exec(`CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, used_at REAL NOT NULL DEFAULT 0, cleaned_at REAL);
      CREATE TABLE IF NOT EXISTS owners(id TEXT NOT NULL,harness TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(id,harness,thread_id));`)
  }
  reference(id: string, owner: AttachmentOwner, now: number): void {
    this.db
      .prepare(
        'INSERT INTO attachments(id,used_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET used_at=excluded.used_at',
      )
      .run(id, now)
    this.db
      .prepare('INSERT OR IGNORE INTO owners(id,harness,thread_id) VALUES(?,?,?)')
      .run(id, owner.harness, owner.threadId)
  }
  owners(id: string): AttachmentOwner[] {
    return this.db
      .prepare('SELECT harness,thread_id FROM owners WHERE id=?')
      .all(id)
      .map((r) => ({ harness: String(r.harness), threadId: String(r.thread_id) }))
  }
  used(id: string): number {
    return Number(
      this.db.prepare('SELECT used_at FROM attachments WHERE id=?').get(id)?.used_at ?? 0,
    )
  }
  cleaned(id: string): boolean {
    return (
      this.db.prepare('SELECT cleaned_at FROM attachments WHERE id=?').get(id)?.cleaned_at != null
    )
  }
  deleting(id: string, now: number): void {
    this.db
      .prepare(
        'INSERT INTO attachments(id,cleaned_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET cleaned_at=excluded.cleaned_at',
      )
      .run(id, now)
  }
  retained(id: string): void {
    this.db.prepare('UPDATE attachments SET cleaned_at=NULL WHERE id=?').run(id)
  }
  close(): void {
    this.db.close()
  }
}
