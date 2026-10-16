import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAgentDir, SettingsManager } from './sdk.mjs'

export function sessionDirectory(cwd: string): string | undefined {
  const directory = process.env.PI_CODING_AGENT_SESSION_DIR
  return directory
    ? directory.replace(/^~(?=\/|$)/, homedir())
    : SettingsManager.create(cwd, getAgentDir()).getSessionDir()
}

export function sessionIndexDirectories(cwds: string[]): string[] {
  return [
    ...new Set([
      join(getAgentDir(), 'sessions'),
      ...cwds.map(sessionDirectory).filter((p): p is string => Boolean(p)),
    ]),
  ]
}

export function fileStamp(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// 只读缓存，不调用官方可能迁移文件的 loader。
export class NativeFiles {
  private readonly cache = new Map<string, { stamp: string; entries: any[] }>()
  read(path: string): any[] {
    const stamp = fileStamp(path)
    if (stamp === null) {
      this.cache.delete(path)
      return []
    }
    const old = this.cache.get(path)
    if (old?.stamp === stamp) return old.entries
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    this.cache.set(path, { stamp, entries })
    return entries
  }
}

export function nativeBranch(entries: any[]): any[] {
  const byId = new Map(entries.filter((e) => e.id && e.type !== 'session').map((e) => [e.id, e]))
  const branch: any[] = []
  let entry = entries.at(-1)
  const visited = new Set<string>()
  while (entry?.id && entry.type !== 'session' && !visited.has(entry.id)) {
    visited.add(entry.id)
    branch.push(entry)
    entry = byId.get(entry.parentId)
  }
  return branch.reverse()
}
