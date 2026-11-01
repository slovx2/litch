import type { QueuedMessage } from '../model.mjs'

/** 只保存在当前客户端；与会话预览缓存分开，避免缓存裁剪删除待发内容。 */
export interface PendingInputStore {
  load(sessionId: string): QueuedMessage[]
  save(sessionId: string, messages: QueuedMessage[]): void
}

export function createPendingInputStore(file: {
  read(): unknown
  write(value: unknown): void
}): PendingInputStore {
  let saved: Record<string, QueuedMessage[]> | undefined
  const read = () => {
    if (saved) return saved
    const raw = file.read() as { version?: unknown; sessions?: Record<string, unknown> } | null
    saved = {}
    if (raw?.version !== 1 || !raw.sessions || typeof raw.sessions !== 'object') return saved
    for (const [id, entries] of Object.entries(raw.sessions)) {
      if (!Array.isArray(entries)) continue
      saved[id] = entries.filter(
        (entry: Partial<QueuedMessage>) =>
          typeof entry?.id === 'string' &&
          typeof entry.text === 'string' &&
          Array.isArray(entry.images) &&
          Array.isArray(entry.extras),
      )
    }
    return saved
  }
  return {
    load: (id) =>
      (read()[id] ?? []).map((entry) => ({
        ...entry,
        // 重启后绝不自动续发；正在交付的条目由原生历史/后续回执对账。
        delivery: entry.delivery === 'unknown' ? 'unknown' : 'held',
      })),
    save(id, messages) {
      const next = { ...read() }
      if (messages.length) next[id] = messages
      else delete next[id]
      file.write({ version: 1, sessions: next })
      saved = next
    },
  }
}
