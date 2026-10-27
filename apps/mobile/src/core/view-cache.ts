// 最近打开过的会话留一份裁过的视图：内存里几个，应用文档目录里再多几个。
// 打开会话时核心手里可能什么都没有（离开超过一阵、核心已经退订放掉了，或者应用在后台被杀掉重开），
// 要等设备连上、整份历史拉完才有第一份快照，这段时间对话区是空的。先拿这里的一份摆出来（只读、标着“旧的”），
// 核心的快照到了整份换掉（session-store.ts 的 seed）。
// 只存最近 KEEP_TURNS 个回合，等人答的请求、排队的消息不存（过时了会误导）；
// 一份太大就再砍一半回合；文件最多 FILE_COUNT 个、合计最多 TOTAL_CHARS 个字，超了先删存得最早的。
// 应用换了版本，视图的形状可能变了：版本对不上的当没存过。
import type { SessionView } from '@litch/core'
import type { JsonFile } from '../shell/json-file'

const KEEP_TURNS = 40
const MEMORY_COUNT = 8
const FILE_COUNT = 24
/** 一份最多这么多字（JSON 文本的长度），合计最多 TOTAL_CHARS */
const FILE_CHARS = 1_500_000
const TOTAL_CHARS = 12_000_000

export interface ViewCache {
  recall(deviceId: string, sessionId: string): SessionView | null
  remember(view: SessionView): void
  /** 设备去掉了：它的会话都不留 */
  forgetDevice(deviceId: string): void
}

interface IndexEntry {
  deviceId: string
  sessionId: string
  file: string
  savedAt: number
  chars: number
}

interface Saved {
  version: string
  deviceId: string
  sessionId: string
  view: SessionView
}

/** 只留最近 turns 个回合和它们的条目；请求、排队清空 */
export function trimView(view: SessionView, turns = KEEP_TURNS): SessionView {
  const kept = view.turns.slice(-turns)
  const items: SessionView['items'] = {}
  for (const turn of kept)
    for (const id of turn.itemIds) {
      const item = view.items[id]
      if (item) items[id] = item
    }
  return { ...view, turns: kept, items, requests: [], queued: [] }
}

const keyOf = (deviceId: string, sessionId: string) => `${deviceId}\n${sessionId}`
const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '_')

export function createViewCache(
  open: <T>(name: string) => JsonFile<T>,
  version: string,
  now: () => number = Date.now,
): ViewCache {
  const memory = new Map<string, SessionView>()
  const indexFile = open<{ version: string; entries: IndexEntry[] }>('views.json')
  let index: IndexEntry[] | null = null

  const entries = (): IndexEntry[] => {
    if (index) return index
    const saved = indexFile.read()
    index = saved?.version === version && Array.isArray(saved.entries) ? saved.entries : []
    return index
  }

  const keepInMemory = (key: string, view: SessionView) => {
    memory.delete(key)
    memory.set(key, view)
    while (memory.size > MEMORY_COUNT) memory.delete(memory.keys().next().value as string)
  }

  const drop = (entry: IndexEntry) => open(entry.file).remove()

  const writeIndex = (next: IndexEntry[]) => {
    index = next
    indexFile.write({ version, entries: next })
  }

  return {
    recall(deviceId, sessionId) {
      const key = keyOf(deviceId, sessionId)
      const hit = memory.get(key)
      if (hit) return hit
      const entry = entries().find((e) => e.deviceId === deviceId && e.sessionId === sessionId)
      if (!entry) return null
      const saved = open<Saved>(entry.file).read()
      if (
        saved?.version !== version ||
        saved.deviceId !== deviceId ||
        saved.sessionId !== sessionId ||
        !Array.isArray(saved.view?.turns)
      )
        return null
      keepInMemory(key, saved.view)
      return saved.view
    },

    remember(full) {
      const { deviceId, sessionId } = full
      let saved: Saved = { version, deviceId, sessionId, view: trimView(full) }
      let text = JSON.stringify(saved)
      while (text.length > FILE_CHARS && saved.view.turns.length > 1) {
        saved = { ...saved, view: trimView(saved.view, Math.floor(saved.view.turns.length / 2)) }
        text = JSON.stringify(saved)
      }
      const { view } = saved
      keepInMemory(keyOf(deviceId, sessionId), view)
      if (text.length > FILE_CHARS) return
      const file = `view-${safe(deviceId)}-${safe(sessionId)}.json`
      open<Saved>(file).write(saved)
      const rest = entries().filter((e) => !(e.deviceId === deviceId && e.sessionId === sessionId))
      const next = [{ deviceId, sessionId, file, savedAt: now(), chars: text.length }, ...rest]
      // 超了数量或合计大小：从存得最早的删起
      let total = 0
      const kept: IndexEntry[] = []
      for (const entry of next) {
        if (kept.length < FILE_COUNT && total + entry.chars <= TOTAL_CHARS) {
          kept.push(entry)
          total += entry.chars
        } else drop(entry)
      }
      writeIndex(kept)
    },

    forgetDevice(deviceId) {
      for (const key of [...memory.keys()]) if (key.startsWith(`${deviceId}\n`)) memory.delete(key)
      const all = entries()
      for (const entry of all) if (entry.deviceId === deviceId) drop(entry)
      writeIndex(all.filter((entry) => entry.deviceId !== deviceId))
    },
  }
}
