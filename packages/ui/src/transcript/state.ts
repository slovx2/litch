// 对话区里只属于界面的两样状态：条目开没开，以及流式文字放到哪了。

import { useCallback, useEffect, useRef, useState } from 'react'

// ---------- 展开状态 ----------
// 按会话、按条目标识记在内存里。组件卸载再回来（切走会话、以后的虚拟化）还是原来的样子。
const toggles = new Map<string, Map<string, boolean>>()

/**
 * 一个可以折叠的东西现在开没开。用户点过就以用户的为准，没点过用 fallback。
 * fallback 可以随时间变（比如活动区在回合进行中是开的，结束后是关的）。
 */
export function useToggle(
  sessionKey: string,
  id: string,
  fallback: boolean,
): [open: boolean, set: (next: boolean) => void] {
  const [picked, setPicked] = useState<boolean | undefined>(() => toggles.get(sessionKey)?.get(id))
  const set = useCallback(
    (next: boolean) => {
      let map = toggles.get(sessionKey)
      if (!map) {
        map = new Map()
        toggles.set(sessionKey, map)
      }
      map.set(id, next)
      setPicked(next)
    },
    [sessionKey, id],
  )
  return [picked ?? fallback, set]
}

// ---------- 匀速放出文字 ----------
// 核心给的是事实：到目前为止收到了哪些文本，一批批到达，有多有少。
// 每帧画多少是界面的事：这里让显示的长度追着实际长度走，积压多就走快一点，大约四分之一秒追平。

const CATCH_UP_MS = 250

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

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
    if (current.frame || current.shown >= target.length) return
    if (reducedMotion()) {
      setShown(target.length)
      return
    }
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

  useEffect(
    () => () => {
      cancelAnimationFrame(state.current.frame)
      state.current.frame = 0
    },
    [],
  )

  // 文本被整个换掉、变短了的情况（重新取了一遍会话）：直接跟上
  const length = Math.min(shown, target.length)
  return {
    text: length === target.length ? target : target.slice(0, length),
    revealing: length < target.length,
  }
}
