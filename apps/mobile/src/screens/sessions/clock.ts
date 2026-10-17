// “多久以前”要跟着时间走：列表一直开着，会话没有新动静，那一行也不会自己重画。
// 全应用共用一个钟，半分钟报一次时；从后台回到前台先报一次（后台时定时器停着）。
// 桌面端的同一件事在 packages/ui/src/app/clock.ts，那里用的是 document 的可见性，手机上换成 AppState。

import { useSyncExternalStore } from 'react'
import { AppState, type NativeEventSubscription } from 'react-native'

/** 相对时间最细到分钟，半分钟一次够了 */
const TICK = 30_000

let ticks = 0
let timer: ReturnType<typeof setInterval> | null = null
let foreground: NativeEventSubscription | null = null
const listeners = new Set<() => void>()

function tick(): void {
  ticks++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    timer = setInterval(tick, TICK)
    foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick()
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || timer === null) return
    clearInterval(timer)
    timer = null
    foreground?.remove()
    foreground = null
  }
}

/** 现在的时间。用了它的组件每半分钟重画一次 */
export function useNow(): number {
  useSyncExternalStore(subscribe, () => ticks)
  return Date.now()
}
