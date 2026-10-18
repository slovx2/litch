// 应用的授权：本会话允许的记在内存里，“始终允许”的存在桌面端用户数据目录的 computer-use-approvals.json。
// 设置页读、删“始终允许”的清单用这里导出的 list、remove。
// 远程设备的会话（invocation.device.kind === 'ssh'）不认“始终允许”：每个会话每个应用都要问。
// 模型在别的机器上，不让一次“始终允许”让它一直能操作这台电脑上的应用。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AlwaysAllowedApp {
  bundleId: string
  name: string
  /** 什么时候加的（ISO 时间） */
  addedAt: string
}

interface StoreFile {
  version: 1
  apps: AlwaysAllowedApp[]
}

export const APPROVALS_FILE = 'computer-use-approvals.json'

export class ApprovalStore {
  private readonly file: string
  /** 会话（设备/会话号）→ 允许过的包标识 */
  private readonly sessions = new Map<string, Set<string>>()

  constructor(userData: string) {
    this.file = join(userData, APPROVALS_FILE)
  }

  /** “始终允许”的清单。文件坏了、不存在都当作空 */
  list(): AlwaysAllowedApp[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreFile>
      if (!Array.isArray(parsed.apps)) return []
      return parsed.apps.filter(
        (one): one is AlwaysAllowedApp =>
          !!one && typeof one.bundleId === 'string' && typeof one.name === 'string',
      )
    } catch {
      return []
    }
  }

  isAlwaysAllowed(bundleId: string): boolean {
    return this.list().some((one) => one.bundleId === bundleId)
  }

  addAlways(app: { bundleId: string; name: string }): void {
    const apps = this.list().filter((one) => one.bundleId !== app.bundleId)
    apps.push({ bundleId: app.bundleId, name: app.name, addedAt: new Date().toISOString() })
    this.write(apps)
  }

  /** 从“始终允许”里删掉一个；回是否真的删了 */
  remove(bundleId: string): boolean {
    const apps = this.list()
    const kept = apps.filter((one) => one.bundleId !== bundleId)
    if (kept.length === apps.length) return false
    this.write(kept)
    return true
  }

  allowForSession(session: string, bundleId: string): void {
    let set = this.sessions.get(session)
    if (!set) this.sessions.set(session, (set = new Set()))
    set.add(bundleId)
  }

  isAllowedForSession(session: string, bundleId: string): boolean {
    return this.sessions.get(session)?.has(bundleId) === true
  }

  private write(apps: AlwaysAllowedApp[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const body: StoreFile = { version: 1, apps }
    // 先写临时文件再改名，写到一半退出也不会留下半个文件
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
