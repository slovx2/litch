import type { FlashListRef } from '@shopify/flash-list'
import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { Row } from '../core/rows'
import { type ReadingMemory, readingOffset, readPosition } from './reading-position'

/**
 * 隐藏的经理对话不挂载列表。回来时先等列表测量，再恢复贴底或消息在可视区的位置；
 * 恢复引起的原生滚动事件不写记忆，用户开始拖动则立即交还控制。
 */
export function useReadingPosition(
  memory: ReadingMemory | undefined,
  list: RefObject<FlashListRef<Row> | null>,
  rows: readonly Row[],
  anchorFrom: number,
) {
  const pending = useRef(memory?.position ?? null)
  const loaded = useRef(false)
  const frame = useRef<number | null>(null)
  const alive = useRef(true)
  const attempt = useRef(0)
  const stable = useRef(0)
  const current = useRef({ rows, anchorFrom })
  current.current = { rows, anchorFrom }
  const capture = useCallback(() => {
    if (!memory || pending.current || !loaded.current || !list.current) return
    const position = readPosition(list.current, current.current.anchorFrom)
    if (position) memory.position = position
  }, [list, memory])
  const settle = useCallback(
    function settle() {
      frame.current = null
      const target = pending.current
      const view = list.current
      if (!alive.current || !target || !view || !loaded.current || !current.current.rows.length)
        return
      const offset = readingOffset(view, target)
      if (offset === null) return
      const distance = Math.abs(view.getAbsoluteLastScrollOffset() - offset)
      stable.current = distance < 1 ? stable.current + 1 : 0
      if (distance >= 1) view.scrollToOffset({ offset, animated: false })
      if (stable.current >= 6) {
        pending.current = null
        capture()
      } else if (++attempt.current < 60) {
        frame.current = requestAnimationFrame(settle)
      }
    },
    [list, capture],
  )
  const layout = useCallback(() => {
    if (!pending.current || !loaded.current || frame.current !== null) return
    attempt.current = 0
    frame.current = requestAnimationFrame(settle)
  }, [settle])
  const load = useCallback(() => {
    loaded.current = true
    layout()
  }, [layout])
  const interrupt = useCallback(() => {
    pending.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [])
  return { pending, capture, layout, load, interrupt }
}
