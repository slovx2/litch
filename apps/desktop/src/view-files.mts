// 会话视图存在用户数据目录下（核心的 view-store.mts）：每台设备一个目录，一个会话一个文件，外加一份索引。
// 核心已经裁过（最近 40 个回合，不带请求和排队）；一份太大再砍一半回合，还大就不存。
// 最多 FILE_COUNT 个文件、合计 TOTAL_CHARS 个字（所有设备一起算），超了先删存得最早的。应用换了版本当没存过。
// 写文件放到这一拍之后做，同一个会话连着存几次只写最后一次，不挡着核心。
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkView, type SessionView, trimView, type ViewStore } from '@litch/core'

const FILE_COUNT = 24
/** 一份最多这么多字（JSON 文本的长度） */
const FILE_CHARS = 1_500_000
const TOTAL_CHARS = 12_000_000

interface IndexEntry {
  deviceId: string
  sessionId: string
  file: string
  savedAt: number
  chars: number
}

interface Saved {
  version: string
  view: SessionView
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, '_')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeText(path: string, text: string): void {
  const next = `${path}.${process.pid}.tmp`
  writeFileSync(next, text, { mode: 0o600 })
  renameSync(next, path)
}

export interface ViewFiles {
  views(deviceId: string): ViewStore
  forgetDevice(deviceId: string): void
}

/** dir 是放这些文件的目录；version 是应用的版本 */
export function viewFiles(dir: string, version: string, now: () => number = Date.now): ViewFiles {
  const indexFile = join(dir, 'index.json')
  let index: IndexEntry[] | null = null
  /** 等着写的：键 → 最新的那一份 */
  const pending = new Map<string, SessionView>()
  let scheduled = false

  const entries = (): IndexEntry[] => {
    if (index) return index
    const saved = readJson(indexFile) as { version?: unknown; entries?: unknown } | null
    index =
      saved?.version === version && Array.isArray(saved.entries)
        ? (saved.entries as IndexEntry[])
        : []
    // 版本对不上：旧文件都不要了
    if (index.length === 0) {
      try {
        for (const name of readdirSync(dir)) if (name.startsWith('view-')) rmSync(join(dir, name))
      } catch {}
    }
    return index
  }

  const writeIndex = (next: IndexEntry[]) => {
    index = next
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeText(indexFile, `${JSON.stringify({ version, entries: next })}\n`)
  }

  const fileOf = (deviceId: string, sessionId: string) =>
    `view-${safe(deviceId)}-${safe(sessionId)}.json`

  const write = (full: SessionView) => {
    const { deviceId, sessionId } = full
    let view = full
    let text = JSON.stringify({ version, view } satisfies Saved)
    while (text.length > FILE_CHARS && view.turns.length > 1) {
      view = trimView(view, Math.floor(view.turns.length / 2))
      text = JSON.stringify({ version, view } satisfies Saved)
    }
    if (text.length > FILE_CHARS) return
    // 先读索引：没有索引时会清掉目录里的旧文件，放在写之后就把刚写的也清了
    const rest = entries().filter((e) => !(e.deviceId === deviceId && e.sessionId === sessionId))
    const file = fileOf(deviceId, sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeText(join(dir, file), text)
    const next = [{ deviceId, sessionId, file, savedAt: now(), chars: text.length }, ...rest]
    let total = 0
    const kept: IndexEntry[] = []
    for (const entry of next) {
      if (kept.length < FILE_COUNT && total + entry.chars <= TOTAL_CHARS) {
        kept.push(entry)
        total += entry.chars
      } else rmSync(join(dir, entry.file), { force: true })
    }
    writeIndex(kept)
  }

  const flush = () => {
    scheduled = false
    const views = [...pending.values()]
    pending.clear()
    for (const view of views) {
      try {
        write(view)
      } catch {
        // 写不进去（磁盘满、没权限）：下次打开就等最新的，不影响使用
      }
    }
  }

  const remove = (match: (entry: IndexEntry) => boolean) => {
    const all = entries()
    const gone = all.filter(match)
    if (gone.length === 0) return
    for (const entry of gone) rmSync(join(dir, entry.file), { force: true })
    writeIndex(all.filter((entry) => !match(entry)))
  }

  return {
    views(deviceId) {
      return {
        load(sessionId) {
          const waiting = pending.get(`${deviceId}\n${sessionId}`)
          if (waiting) return waiting
          const entry = entries().find((e) => e.deviceId === deviceId && e.sessionId === sessionId)
          if (!entry) return null
          const saved = readJson(join(dir, entry.file)) as Partial<Saved> | null
          if (saved?.version !== version) return null
          return checkView(saved.view, deviceId, sessionId)
        },
        save(view) {
          pending.set(`${deviceId}\n${view.sessionId}`, view)
          if (scheduled) return
          scheduled = true
          setTimeout(flush, 0)
        },
        forget(sessionId) {
          pending.delete(`${deviceId}\n${sessionId}`)
          try {
            remove((e) => e.deviceId === deviceId && e.sessionId === sessionId)
          } catch {}
        },
      }
    },
    forgetDevice(deviceId) {
      for (const key of [...pending.keys()])
        if (key.startsWith(`${deviceId}\n`)) pending.delete(key)
      try {
        remove((e) => e.deviceId === deviceId)
      } catch {}
    },
  }
}
