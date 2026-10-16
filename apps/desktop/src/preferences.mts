// 外壳自己记的几样偏好，存在用户数据目录下的 preferences.json 里：退出时还有终端在运行怎么办（quit-terminals.mts）、
// 上一次的皮肤、明暗和缩放（look.mts）。各管各的那一项，写的时候别的项原样留着。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'preferences.json'

/** 整份读出来。读不到、读不懂都是空的 */
export function readPreferences(dataDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // 没存过
    return {}
  }
}

/** 改其中一项。先写到旁边再换名字：写到一半断电也不会留下半份 */
export function writePreference(dataDir: string, key: string, value: unknown): void {
  const path = join(dataDir, FILE)
  const next = `${path}.${process.pid}.tmp`
  writeFileSync(
    next,
    `${JSON.stringify({ ...readPreferences(dataDir), [key]: value }, null, 2)}\n`,
    { mode: 0o600 },
  )
  renameSync(next, path)
}
