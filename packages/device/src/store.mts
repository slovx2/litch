// 设备进程自己的库（<状态目录>/device.sqlite）。里面是设备层的数据，不是任何引擎的：
// - threads：见过的会话属于哪个 harness（路由要用），外加它的近况（更新时间、归没归档、是不是临时的）
// - 工作区、会话到工作区的归属、分区与置顶（表由 workspaces.mts、sections.mts 建）
// - 从各引擎导入过没有（workspace-import.mts）
// 项目、归属、分区和权限确认都是持久数据；任何版本都不能删库重建。
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

/**
 * v2 已保存设备独有的项目和归属，不能靠引擎重新导入恢复。
 * v3 增加项目权限，v4 增加重启续跑；v5 仅重建权限表为目录与 harness 复合键，旧权限作废。
 * 升级在原库事务内完成，禁止删库重建；未知版本拒绝打开并保留文件。
 */
const SCHEMA_VERSION = 6

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
    const version = schemaVersion(path)
    if (version > SCHEMA_VERSION)
      throw new Error(
        `设备库是更新的版本（${version}）建的，这一版设备服务只支持到 ${SCHEMA_VERSION}，拒绝降级打开`,
      )
    if (version < 2)
      throw new Error(`设备库版本 ${version} 没有可用迁移，已保留原库；请先备份并联系维护者`)
  }
  // 库文件只有属主可读写，和这个目录里别的文件一致。先把文件建出来再打开：
  // 预写日志等附带的文件会沿用主文件的权限
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  // 初始化和升级一起提交，失败时连版本号也不变。
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version !== 0) {
      // 不能用 CREATE IF NOT EXISTS 掩盖损坏或未知的旧结构。
      db.prepare(
        'SELECT id,harness,updated_at,archived,ephemeral,seen_at FROM threads LIMIT 0',
      ).all()
    }
    initializeStoreFormat(db)
    db.exec(`CREATE TABLE IF NOT EXISTS threads(
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      ephemeral INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;`)
    // v2 → v3：权限必须重新明确确认，不能从会话或项目归属推断。
    if (version < 3)
      db.exec(`CREATE TABLE IF NOT EXISTS project_permissions(
        cwd TEXT PRIMARY KEY, permission TEXT NOT NULL, confirmed TEXT NOT NULL
      ) WITHOUT ROWID;`)
    // v3 → v4：只新增续跑记录，不动项目、归属、分区、导入标记或权限。
    if (version < 4)
      db.exec(`CREATE TABLE IF NOT EXISTS restart_turns(
      thread_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      token TEXT NOT NULL,
      turn_id TEXT,
      state TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      prepared_at INTEGER,
      resume_turn_id TEXT
    ) WITHOUT ROWID;`)
    // v4 → v5：旧权限跨 harness 共享，不迁移值或确认。只重建这一张表，其他持久数据不动。
    if (version < 5)
      db.exec(`DROP TABLE IF EXISTS project_permissions;
      CREATE TABLE project_permissions(
        cwd TEXT NOT NULL, harness TEXT NOT NULL, permission TEXT NOT NULL, confirmed TEXT NOT NULL,
        PRIMARY KEY(cwd,harness)
      ) WITHOUT ROWID;`)
    // v5 → v6：重启前保存后台任务摘要，恢复时不会从已经消失的进程猜测。
    if (version < 6)
      db.exec("ALTER TABLE restart_turns ADD COLUMN background TEXT NOT NULL DEFAULT '[]'")
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  db.exec('PRAGMA journal_mode=WAL;')
  return db
}
