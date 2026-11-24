// manager.sqlite 里的飞书表：应用配置、幂等记录、审计。键列加 body JSON，照经理库的写法。
// 连接状态是运行时的，只在内存里（service.mts），不进库。
import type { FeishuCapability } from '../../../protocol/src/feishu.mjs'
import type { ManagerStore } from '../manager-store.mjs'

export const FEISHU_APPS_MIGRATION = `
CREATE TABLE feishu_apps(app_id TEXT PRIMARY KEY NOT NULL, manager_id TEXT UNIQUE, body TEXT NOT NULL);
CREATE TABLE feishu_operations(
  scope TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope, operation_id)
);
CREATE TABLE feishu_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT, at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX feishu_audit_app ON feishu_audit(app_id, seq);
`

/** 库里存的应用记录：不含连接状态，不含秘密 */
export interface FeishuAppRecord {
  appId: string
  revision: number
  name: string
  botOpenId?: string
  avatar?: string
  managerId: string | null
  enabled: boolean
  credential: { generation: number; updatedAt: number }
  capability: FeishuCapability | null
  creatorOpenId?: string
  createdAt: number
}

export type FeishuAuditAction =
  | 'app_added'
  | 'app_rotated'
  | 'app_updated'
  | 'app_removed'
  | 'app_upgrade_submitted'

export interface FeishuAuditEntry {
  action: FeishuAuditAction
  /** 发起的连接：管理员连接或设备自己 */
  by: 'admin' | 'device'
  detail?: Record<string, string | number | boolean | null>
}

const parse = <T,>(row: Record<string, unknown> | undefined): T | null =>
  row ? (JSON.parse(String(row.body)) as T) : null

export class FeishuStore {
  readonly managers: ManagerStore
  constructor(managers: ManagerStore) {
    this.managers = managers
  }

  private get db() {
    return this.managers.db
  }

  transaction<T>(work: () => T): T {
    return this.managers.transaction(work)
  }

  apps(): FeishuAppRecord[] {
    return this.db
      .prepare('SELECT body FROM feishu_apps ORDER BY rowid')
      .all()
      .map((row) => parse<FeishuAppRecord>(row) as FeishuAppRecord)
  }

  app(appId: string): FeishuAppRecord | null {
    return parse(this.db.prepare('SELECT body FROM feishu_apps WHERE app_id=?').get(appId))
  }

  appForManager(managerId: string): FeishuAppRecord | null {
    return parse(this.db.prepare('SELECT body FROM feishu_apps WHERE manager_id=?').get(managerId))
  }

  saveApp(app: FeishuAppRecord): void {
    this.db
      .prepare(
        `INSERT INTO feishu_apps VALUES(?,?,?)
         ON CONFLICT(app_id) DO UPDATE SET manager_id=excluded.manager_id, body=excluded.body`,
      )
      .run(app.appId, app.managerId, JSON.stringify(app))
  }

  removeApp(appId: string): void {
    this.db.prepare('DELETE FROM feishu_apps WHERE app_id=?').run(appId)
  }

  /** 同一操作 ID 重复提交时返回第一次的结果 */
  operation<T>(scope: string, operationId: string): T | null {
    return parse(
      this.db
        .prepare('SELECT body FROM feishu_operations WHERE scope=? AND operation_id=?')
        .get(scope, operationId),
    )
  }

  saveOperation(scope: string, operationId: string, result: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO feishu_operations VALUES(?,?,?)')
      .run(scope, operationId, JSON.stringify(result))
  }

  audit(appId: string | null, at: number, entry: FeishuAuditEntry): void {
    this.db
      .prepare('INSERT INTO feishu_audit(app_id, at, body) VALUES(?,?,?)')
      .run(appId, at, JSON.stringify(entry))
  }

  auditEntries(appId: string): (FeishuAuditEntry & { at: number })[] {
    return this.db
      .prepare('SELECT at, body FROM feishu_audit WHERE app_id=? ORDER BY seq')
      .all(appId)
      .map((row) => ({ ...(JSON.parse(String(row.body)) as FeishuAuditEntry), at: Number(row.at) }))
  }
}
