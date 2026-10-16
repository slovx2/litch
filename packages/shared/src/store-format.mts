import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const APPLICATION_ID = 0x43484131

// 在打开写连接前拒绝旧格式，不修改旧数据库的 journal 或用户数据。
export function assertStoreFormat(path: string): void {
  if (!existsSync(path)) return
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('PRAGMA application_id').get()
    if (row?.application_id !== APPLICATION_ID)
      throw new Error('旧适配器数据库不受支持；请使用新的 codex-harness-adapter 状态目录')
  } finally {
    db.close()
  }
}

export function initializeStoreFormat(db: Pick<DatabaseSync, 'exec'>): void {
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
}
