// 刚看过的几个会话留着不关：离开详情页之后会话存储继续订阅一阵，再进来时行已经是建好的，
// 不用再经 SSH 向设备要一遍整个会话、再把十万字切一遍（T4：进会话）。
// 最多留 KEEP_COUNT 个，离开超过 KEEP_MS 的关掉。
import type { CoreChannel } from '@litch/core'
import { SessionStore } from './session-store'

const KEEP_COUNT = 3
const KEEP_MS = 60_000

interface Entry {
  store: SessionStore
  users: number
  timer: ReturnType<typeof setTimeout> | null
  leftAt: number
}

const entries = new Map<string, Entry>()

export function acquireStore(
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
): SessionStore {
  const key = `${deviceId}\n${sessionId}`
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      store: new SessionStore(channel, deviceId, sessionId),
      users: 0,
      timer: null,
      leftAt: 0,
    }
    entry.store.start()
    entries.set(key, entry)
  }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.users += 1
  return entry.store
}

export function releaseStore(store: SessionStore): void {
  const key = `${store.deviceId}\n${store.sessionId}`
  const entry = entries.get(key)
  if (!entry) return
  entry.users -= 1
  if (entry.users > 0) return
  entry.leftAt = Date.now()
  entry.timer = setTimeout(() => close(key), KEEP_MS)
  // 超过上限时先关离开最久的
  const idle = [...entries]
    .filter(([, e]) => e.users === 0)
    .sort((a, b) => a[1].leftAt - b[1].leftAt)
  for (const [oldKey] of idle.slice(0, Math.max(0, idle.length - KEEP_COUNT))) close(oldKey)
}

function close(key: string): void {
  const entry = entries.get(key)
  if (!entry || entry.users > 0) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.store.stop()
  entries.delete(key)
}
