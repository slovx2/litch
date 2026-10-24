// 对话区里只属于界面的两样状态：条目开没开，以及流式文字放到哪了。

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranscriptView } from './view.ts'

// ---------- 展开状态 ----------
// 按会话、按条目标识记在内存里。组件卸载再回来（切走会话、以后的虚拟化）还是原来的样子。
const toggles = new Map<string, Map<string, boolean>>()
const toggleListeners = new Set<(key: string) => void>()
const toggleKey = (sessionKey: string, id: string) => `${sessionKey}\n${id}`

function pickToggle(sessionKey: string, id: string, next: boolean): void {
  let map = toggles.get(sessionKey)
  if (!map) {
    map = new Map()
    toggles.set(sessionKey, map)
  }
  map.set(id, next)
  const key = toggleKey(sessionKey, id)
  for (const listener of toggleListeners) listener(key)
}

/**
 * 一个可以折叠的东西现在开没开。用户点过就以用户的为准，没点过用 fallback。
 * fallback 可以随时间变（比如活动区在回合进行中是开的，结束后是关的）；id 也可以变（换了一档视图）。
 */
export function useToggle(
  sessionKey: string,
  id: string,
  fallback: boolean,
): [open: boolean, set: (next: boolean) => void] {
  // 别处替它开（跳到收起的过程里的一段原文）时跟着变
  const subscribe = useCallback(
    (listener: () => void) => {
      const key = toggleKey(sessionKey, id)
      const changed = (which: string) => {
        if (which === key) listener()
      }
      toggleListeners.add(changed)
      return () => {
        toggleListeners.delete(changed)
      }
    },
    [sessionKey, id],
  )
  const picked = useSyncExternalStore(subscribe, () => toggles.get(sessionKey)?.get(id))
  const set = useCallback((next: boolean) => pickToggle(sessionKey, id, next), [sessionKey, id])
  return [picked ?? fallback, set]
}

/** 详细视图里点过的开合另记一份：切回精简还是原来的样子，再切到详细也还是那时点成的样子 */
const VERBOSE = 'v:'

/**
 * 对话里的步骤组、条目、整段过程开没开：跟着这个会话的视图走。
 * 精简视图照 fallback；详细视图里一律先开着，用户在详细视图里收起的单记一份
 */
export function useFold(
  sessionKey: string,
  id: string,
  fallback: boolean,
): [open: boolean, set: (next: boolean) => void] {
  const verbose = useTranscriptView(sessionKey) === 'verbose'
  return useToggle(sessionKey, verbose ? VERBOSE + id : id, verbose || fallback)
}

/** 从外面替一个可折叠的东西定开没开：和用户点了一样，正画着的那个跟着变。两档视图都算 */
export function setToggle(sessionKey: string, id: string, next: boolean): void {
  pickToggle(sessionKey, id, next)
  pickToggle(sessionKey, VERBOSE + id, next)
}

// ---------- 回合里手动展开过没有 ----------
// 用户在一个回合里手动展开过某一组步骤或某一条，回合结束时就不自动把整段过程收起来（照 Codex）。
// 按“会话 + 回合”记在内存里，和上面的展开状态一样，切走再回来还在。
const touched = new Set<string>()
const touchListeners = new Set<() => void>()

const turnKey = (sessionKey: string, turnId: string) => `${sessionKey}\n${turnId}`

/** 记下这个回合被手动展开过 */
export function touchTurn(sessionKey: string, turnId: string): void {
  const key = turnKey(sessionKey, turnId)
  if (touched.has(key)) return
  touched.add(key)
  for (const listener of touchListeners) listener()
}

function subscribeTouch(listener: () => void): () => void {
  touchListeners.add(listener)
  return () => touchListeners.delete(listener)
}

/** 这个回合有没有被手动展开过 */
export function useTurnTouched(sessionKey: string, turnId: string): boolean {
  return useSyncExternalStore(subscribeTouch, () => touched.has(turnKey(sessionKey, turnId)))
}

/** 回合里的东西被手动展开时调它；不在回合里（比如子代理页）时什么都不做 */
export const TurnTouch = createContext<() => void>(() => {})

// ---------- 正在跑的那一条从什么时候开始 ----------
// 命令有自己看着开始的时刻（startedAt）；工具调用、思考没有，就记下这边第一次看到它在跑的时刻
const firstSeen = new Map<string, number>()

/** 这一条从什么时候开始跑的（本机的钟）。给了 known 就用它 */
export function seenSince(key: string, known: number | null): number {
  if (known !== null) return known
  let since = firstSeen.get(key)
  if (since === undefined) {
    since = Date.now()
    firstSeen.set(key, since)
  }
  return since
}

// ---------- 匀速放出文字 ----------
// 核心给的是事实：到目前为止收到了哪些文本，一批批到达，有多有少。
// 每帧画多少是界面的事：这里让显示的长度追着实际长度走，积压多就走快一点，大约四分之一秒追平。

const CATCH_UP_MS = 250

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// 窗口在后台（最小化、被别的窗口整个挡住、在别的桌面）时浏览器不跑动画帧：
// 放字要是靠它，就停在第一批上，回合结束了还画着光标。这时没人在看，直接全显示
const hidden = () => typeof document !== 'undefined' && document.hidden

/**
 * 返回现在该显示的那一段文本，以及是不是还没放完。
 * 组件第一次出现时已经有的文本直接全显示（历史消息、打开时已经流了一半的回答），之后新到的才匀速放出。
 */
export function useSmoothText(target: string): { text: string; revealing: boolean } {
  const [shown, setShown] = useState(target.length)
  const state = useRef({ shown, target, last: 0, frame: 0 })
  state.current.target = target
  state.current.shown = shown

  useEffect(() => {
    const current = state.current
    if (current.shown >= target.length) return
    if (reducedMotion() || hidden()) {
      cancelAnimationFrame(current.frame)
      current.frame = 0
      setShown(target.length)
      return
    }
    if (current.frame) return
    current.last = performance.now()
    const step = (now: number) => {
      const backlog = current.target.length - current.shown
      if (backlog <= 0) {
        current.frame = 0
        return
      }
      const elapsed = Math.max(1, now - current.last)
      current.last = now
      let next = current.shown + Math.max(1, Math.ceil((backlog * elapsed) / CATCH_UP_MS))
      next = Math.min(next, current.target.length)
      // 不把一个字拆成两半（代理对）
      const code = current.target.charCodeAt(next - 1)
      if (code >= 0xd800 && code <= 0xdbff && next < current.target.length) next++
      current.shown = next
      setShown(next)
      current.frame = requestAnimationFrame(step)
    }
    current.frame = requestAnimationFrame(step)
  }, [target])

  useEffect(() => {
    // 放到一半窗口进了后台：排着的那一帧不会来，直接放完
    const onHide = () => {
      const current = state.current
      if (!hidden() || current.shown >= current.target.length) return
      cancelAnimationFrame(current.frame)
      current.frame = 0
      setShown(current.target.length)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      cancelAnimationFrame(state.current.frame)
      state.current.frame = 0
    }
  }, [])

  // 文本被整个换掉、变短了的情况（重新取了一遍会话）：直接跟上
  const length = Math.min(shown, target.length)
  return {
    text: length === target.length ? target : target.slice(0, length),
    revealing: length < target.length,
  }
}
