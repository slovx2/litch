// 项目权限归设备、真实目录与 harness 所有；桌面和手机共享同一范围的确认记录。
import { realpathSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  PROJECT_PERMISSION,
  type ProjectPermission,
  permissionLevel,
} from '../../protocol/src/harness-project-permissions.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
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
      cwd TEXT NOT NULL, harness TEXT NOT NULL, permission TEXT NOT NULL, confirmed TEXT NOT NULL,
      PRIMARY KEY(cwd,harness)
    ) WITHOUT ROWID`)
  }
  read(cwd: string, harness: string): ProjectPermission {
    if (!harness.trim()) throw new ProtocolError(-32602, '需要非空 harness 字符串')
    // 空目录是这台设备的“无项目”范围，不能拿某个 harness 的默认目录代替。
    let path = ''
    if (cwd !== '') {
      const resolved = requireDeviceDirectory(cwd)
      try {
        path = realpathSync(resolved)
        if (!statSync(path).isDirectory()) throw new Error('不是目录')
      } catch {
        throw new DirectoryError('unreadableDirectory', cwd, resolved)
      }
    }
    const row = this.db
      .prepare('SELECT * FROM project_permissions WHERE cwd=? AND harness=?')
      .get(path, harness)
    return {
      cwd: path,
      harness,
      permission: permissionLevel(row?.permission),
      confirmedPermissions: row ? JSON.parse(String(row.confirmed)) : [],
    }
  }
  call(method: string, value: unknown, confirmationRequired = true): ProjectPermission {
    const fields = isObject(value) ? value : {}
    if (typeof fields.cwd !== 'string') throw new ProtocolError(-32602, '需要 cwd 字符串')
    if (typeof fields.harness !== 'string') throw new ProtocolError(-32602, '需要 harness 字符串')
    const current = this.read(fields.cwd, fields.harness)
    if (method === PROJECT_PERMISSION.read) return current
    if (method !== PROJECT_PERMISSION.set) throw new ProtocolError(-32601, '未知项目权限方法')
    const permission = permissionLevel(fields.permission)
    if (!permission || typeof fields.confirmed !== 'boolean')
      throw new ProtocolError(-32602, '需要有效的 permission 和 confirmed')
    const confirmed = new Set(current.confirmedPermissions)
    if (fields.confirmed && confirmationRequired) confirmed.add(permission)
    if (permission === ':danger-full-access' && confirmationRequired && !confirmed.has(permission))
      throw new ProtocolError(-32602, '完全访问需要用户明确确认')
    const next = { ...current, permission, confirmedPermissions: [...confirmed] }
    this.db
      .prepare(`INSERT INTO project_permissions VALUES(?,?,?,?)
      ON CONFLICT(cwd,harness) DO UPDATE SET permission=excluded.permission, confirmed=excluded.confirmed`)
      .run(next.cwd, next.harness, permission, JSON.stringify(next.confirmedPermissions))
    this.announce(PROJECT_PERMISSION.changed, next, EXTENSION.harnessProjectPermissions)
    return next
  }
}
