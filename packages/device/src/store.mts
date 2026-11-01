// 设备进程自己的库（<状态目录>/device.sqlite）。里面是设备层的数据，不是任何引擎的：
// - threads：见过的会话属于哪个 harness（路由要用），外加它的近况（更新时间、归没归档、是不是临时的）
// - 工作区、会话到工作区的归属、分区与置顶（表由 workspaces.mts、sections.mts 建）
// - 从各引擎导入过没有（workspace-import.mts）
// 项目权限确认也在本库；不能把整库当成可重建缓存删除。
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

/**
 * 库包含不能重建的项目权限确认；版本不匹配时拒绝打开，不删除数据。
 */
const SCHEMA_VERSION = 2

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  } finally {
    db.close()
  }
}

export function openDeviceStore(stateDir: string): DatabaseSync {
  const path = join(stateDir, 'device.sqlite')
  ensureParent(path)
  // 空文件就是一个还没写过的新库（上一次刚建出来就被打断也会留下它），不算旧格式
  if (existsSync(path) && statSync(path).size > 0) {
    assertStoreFormat(path)
    if (schemaVersion(path) !== SCHEMA_VERSION)
      throw new Error('设备库版本不匹配，拒绝打开以保留项目权限与设备数据')
  }
  // 库文件只有属主可读写，和这个目录里别的文件一致。先把文件建出来再打开：
  // 预写日志等附带的文件会沿用主文件的权限
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  initializeStoreFormat(db)
  // 表名和列名要和 packages/shared 项目存储的 threadsTable 对得上：算工作区的最近活动时间、
  // 判断会话存不存在、是不是临时的，查的就是这张表
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA user_version=${SCHEMA_VERSION};
    CREATE TABLE IF NOT EXISTS threads(
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      ephemeral INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;`)
  return db
}
