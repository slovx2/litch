// 回退之后把那条消息放回输入框：对话区（回退的一方）和输入区（C2 的 Composer）之间只经这里说话。
// 输入区按会话订阅（onRefill）；回退成了对话区交一条过来（refillDraft）。那时输入区还没订阅的，先存着，
// 一订阅就交给它。同一个会话只留最后一条。
import type { ImageAttachment } from '@litch/core'

export interface RefillMessage {
  text: string
  images: ImageAttachment[]
}

type Listener = (message: RefillMessage) => void

const listeners = new Map<string, Set<Listener>>()
const pending = new Map<string, RefillMessage>()

const keyOf = (deviceId: string, sessionId: string) => `${deviceId}\n${sessionId}`

export function refillDraft(deviceId: string, sessionId: string, message: RefillMessage): void {
  const key = keyOf(deviceId, sessionId)
  const set = listeners.get(key)
  if (!set || set.size === 0) {
    pending.set(key, message)
    return
  }
  for (const listener of set) listener(message)
}

/** 输入区订阅这个会话要放回来的消息。返回退订 */
export function onRefill(deviceId: string, sessionId: string, listener: Listener): () => void {
  const key = keyOf(deviceId, sessionId)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  const waiting = pending.get(key)
  if (waiting) {
    pending.delete(key)
    listener(waiting)
  }
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}
