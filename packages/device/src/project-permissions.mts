// 项目权限归设备和真实目录所有，客户端与 harness 不分别保存确认记录。
import { realpathSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  PROJECT_PERMISSION,
  type ProjectPermission,
  permissionLevel,
} from '../../protocol/src/project-permissions.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import { DirectoryError, requireDeviceDirectory } from './directory-validation.mjs'
import { isObject } from './wire.mjs'
import type { Announce } from './workspaces.mjs'

export class ProjectPermissions {
  private readonly db: DatabaseSync
  private readonly announce: Announce
  constructor(db: DatabaseSync, announce: Announce) {
    this.db = db
    this.announce = announce
    db.exec(`CREATE TABLE IF NOT EXISTS project_permissions(
      cwd TEXT PRIMARY KEY, permission TEXT NOT NULL, confirmed TEXT NOT NULL
    ) WITHOUT ROWID`)
  }
  read(cwd: string): ProjectPermission {
    const resolved = requireDeviceDirectory(cwd)
    let path: string
    try {
      path = realpathSync(resolved)
      if (!statSync(path).isDirectory()) throw new Error('不是目录')
    } catch {
      throw new DirectoryError('unreadableDirectory', cwd, resolved)
    }
    const row = this.db.prepare('SELECT * FROM project_permissions WHERE cwd=?').get(path)
    return {
      cwd: path,
      permission: permissionLevel(row?.permission),
      confirmedPermissions: row ? JSON.parse(String(row.confirmed)) : [],
    }
  }
  call(method: string, value: unknown): ProjectPermission {
    const fields = isObject(value) ? value : {}
    const current = this.read(requiredString(fields.cwd, 'cwd'))
    if (method === PROJECT_PERMISSION.read) return current
    if (method !== PROJECT_PERMISSION.set) throw new ProtocolError(-32601, '未知项目权限方法')
    const permission = permissionLevel(fields.permission)
    if (!permission || typeof fields.confirmed !== 'boolean')
      throw new ProtocolError(-32602, '需要有效的 permission 和 confirmed')
    const confirmed = new Set(current.confirmedPermissions)
    if (fields.confirmed) confirmed.add(permission)
    if (permission === ':danger-full-access' && !confirmed.has(permission))
      throw new ProtocolError(-32602, '完全访问需要用户明确确认')
    const next = { ...current, permission, confirmedPermissions: [...confirmed] }
    this.db
      .prepare(`INSERT INTO project_permissions VALUES(?,?,?)
      ON CONFLICT(cwd) DO UPDATE SET permission=excluded.permission, confirmed=excluded.confirmed`)
      .run(next.cwd, permission, JSON.stringify(next.confirmedPermissions))
    this.announce(PROJECT_PERMISSION.changed, next, EXTENSION.projectPermissions)
    return next
  }
}
