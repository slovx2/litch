import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { BoardPageMemory } from '../../../core/src/manager-board-memory.mts'

/** 切页签时先等待列表与展开详情，绘制前恢复；加载期的钳位和旧 scroll 事件不能覆盖记忆。 */
export function useBoardScroll(
  root: RefObject<HTMLElement | null>,
  memory: BoardPageMemory,
  ready: boolean,
  enabled = true,
) {
  const restored = useRef<BoardPageMemory | null>(null)
  const [, render] = useState(0)
  const pending = restored.current !== memory
  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>('.mg-body')
    if (!enabled || !host || !ready || restored.current === memory) return
    const anchor = host.style.overflowAnchor
    // 返回后的卡片先完成宽度测量，避免浏览器滚动锚定再次挪动已恢复的位置。
    host.style.overflowAnchor = 'none'
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        host.style.overflowAnchor = anchor
      })
    })
    host.scrollTop = memory.y
    restored.current = memory
    render((value) => value + 1)
    return () => {
      cancelAnimationFrame(frame)
      host.style.overflowAnchor = anchor
    }
  }, [root, memory, ready, enabled])
  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>('.mg-body')
    if (!enabled || !host) return
    const remember = () => {
      if (restored.current === memory) memory.y = host.scrollTop
    }
    host.addEventListener('scroll', remember)
    // 会话链接在同一点击里卸载看板；捕获阶段先保存，避免最后一次 scroll 尚未送达。
    host.addEventListener('click', remember, true)
    return () => {
      host.removeEventListener('scroll', remember)
      host.removeEventListener('click', remember, true)
    }
  }, [root, memory, enabled])
  return pending
}
