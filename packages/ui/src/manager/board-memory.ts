import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { BoardPageMemory } from '../../../core/src/manager-board-memory.mts'

/** 切页签时先等待列表与展开详情，绘制前恢复；加载期的钳位和旧 scroll 事件不能覆盖记忆。 */
export function useBoardScroll(
  root: RefObject<HTMLElement | null>,
  memory: BoardPageMemory,
  ready: boolean,
) {
  const restored = useRef<BoardPageMemory | null>(null)
  const [, render] = useState(0)
  const pending = restored.current !== memory
  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>('.mg-body')
    if (!host || !ready || restored.current === memory) return
    host.scrollTop = memory.y
    restored.current = memory
    render((value) => value + 1)
  })
  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>('.mg-body')
    if (!host) return
    const remember = () => {
      if (restored.current === memory) memory.y = host.scrollTop
    }
    host.addEventListener('scroll', remember)
    return () => host.removeEventListener('scroll', remember)
  }, [root, memory])
  return pending
}
