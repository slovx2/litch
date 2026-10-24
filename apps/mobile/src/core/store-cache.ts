// 刚看过的几个会话留着不关：离开详情页之后会话存储继续订阅一阵，再进来时行已经是建好的，
// 不用再经 SSH 向设备要一遍整个会话、再把十万字切一遍（T4：进会话）。
// 最多留 KEEP_COUNT 个，离开超过 KEEP_MS 的关掉。
// 在跑的会话离开时就关、留着的开始跑了也关：核心按“有没有人订阅”判断回合结束时标不标未读，
// 留着不关的订阅会让离开后才结束的回合不出未读。
import type { CoreChannel } from '@litch/core'
import { SessionStore } from './session-store'

const KEEP_COUNT = 3
const KEEP_MS = 60_000

interface Entry {
  store: SessionStore
  users: number
  timer: ReturnType<typeof setTimeout> | null
  leftAt: number
  /** 离开后盯着它开没开始跑 */
  unwatch: (() => void) | null
}

const entries = new Map<string, Entry>()
/** 存储只给建它的那条通道用：换了核心的装法（新通道）不能拿出连着旧通道的 */
const channelIds = new WeakMap<CoreChannel, number>()
let channelSeq = 0
const storeKeys = new WeakMap<SessionStore, string>()

export function acquireStore(
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
): SessionStore {
  let channelId = channelIds.get(channel)
  if (channelId === undefined) {
    channelId = ++channelSeq
    channelIds.set(channel, channelId)
  }
  const key = `${channelId}\n${deviceId}\n${sessionId}`
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      store: new SessionStore(channel, deviceId, sessionId),
      users: 0,
      timer: null,
      leftAt: 0,
      unwatch: null,
    }
    entry.store.start()
    entries.set(key, entry)
    storeKeys.set(entry.store, key)
  }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.unwatch?.()
  entry.unwatch = null
  entry.users += 1
  return entry.store
}

export function releaseStore(store: SessionStore): void {
  const key = storeKeys.get(store)
  const entry = key === undefined ? undefined : entries.get(key)
  if (key === undefined || !entry) return
  entry.users -= 1
  if (entry.users > 0) return
  if (store.runningNow()) {
    close(key)
    return
  }
  entry.leftAt = Date.now()
  entry.timer = setTimeout(() => close(key), KEEP_MS)
  entry.unwatch = store.subscribeData(() => {
    if (store.runningNow()) close(key)
  })
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
  entry.unwatch?.()
  entry.store.stop()
  entries.delete(key)
}
