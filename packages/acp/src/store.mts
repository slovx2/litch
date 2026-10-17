import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

// 只保存界面元数据（归档、分组、项目、队列）和适配器经手的会话的摘要和回合、客户端发来的输入的原样（回显用，见 AcpServer.remember）；
// 会话历史以 agent 为准（session/load 回放）；agent 回放不了的，用这里存的回合（AcpServer.open）。
export class AcpStore {
  readonly db: DatabaseSync
  constructor(home: string) {
    const path = join(home, 'adapter.sqlite')
    assertStoreFormat(path)
    ensureParent(path)
    this.db = new DatabaseSync(path)
    initializeStoreFormat(this.db)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS metadata(scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));`)
  }
  getMeta(scope: string, id: string): any {
    const row = this.db.prepare('SELECT data FROM metadata WHERE scope=? AND id=?').get(scope, id)
    return row ? JSON.parse(String(row.data)) : null
  }
  setMeta(scope: string, id: string, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data',
      )
      .run(scope, id, JSON.stringify(data))
  }
  listMeta(scope: string): any[] {
    return this.db
      .prepare('SELECT data FROM metadata WHERE scope=? ORDER BY id')
      .all(scope)
      .map((row) => JSON.parse(String(row.data)))
  }
  deleteMeta(scope: string, id: string): void {
    this.db.prepare('DELETE FROM metadata WHERE scope=? AND id=?').run(scope, id)
  }
  close(): void {
    this.db.close()
  }
}
