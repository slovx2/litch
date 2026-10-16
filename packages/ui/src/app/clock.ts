// “多久以前”这类字要跟着时间走：窗口一直开着，会话没有新动静，那一行也不会自己重画，
// 十分钟前的会话会一直写着“现在”。这里放一个全界面共用的钟，隔一会儿报一次时，用到它的组件跟着重画。
import { useSyncExternalStore } from 'react'

/** 多久报一次时。相对时间最细到分钟，半分钟一次够了 */
const TICK = 30_000

let ticks = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick(): void {
  ticks++
  for (const listener of listeners) listener()
}

/** 窗口从后台回到前台：后台时定时器会被放慢，回来先对一次时 */
function onVisible(): void {
  if (document.visibilityState === 'visible') tick()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    timer = setInterval(tick, TICK)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || timer === null) return
    clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** 现在的时间。用了它的组件每半分钟重画一次，显示相对时间的地方用它，不直接读系统时间 */
export function useNow(): number {
  useSyncExternalStore(subscribe, () => ticks)
  return Date.now()
}

// 正在跑的东西“已经用了多久”要一秒一秒地走。和上面那个钟分开：这个只在有东西在跑的时候才走，
// 用它的只有那一行自己，别的行不跟着重画。
let seconds = 0
let secondTimer: ReturnType<typeof setInterval> | null = null
const secondListeners = new Set<() => void>()

function subscribeSeconds(listener: () => void): () => void {
  secondListeners.add(listener)
  if (secondTimer === null) {
    secondTimer = setInterval(() => {
      seconds++
      for (const each of secondListeners) each()
    }, 1000)
  }
  return () => {
    secondListeners.delete(listener)
    if (secondListeners.size > 0 || secondTimer === null) return
    clearInterval(secondTimer)
    secondTimer = null
  }
}

const idle = (): (() => void) => () => {}

/** 从 since 到现在过了多少毫秒，每秒更新一次。since 是 null 就不走、返回 null */
export function useElapsed(since: number | null): number | null {
  useSyncExternalStore(since === null ? idle : subscribeSeconds, () => seconds)
  return since === null ? null : Math.max(0, Date.now() - since)
}
