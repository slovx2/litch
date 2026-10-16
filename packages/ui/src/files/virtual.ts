// 只画看得见的那一段：行高固定，按滚到哪了算出该画第几行到第几行。文件树和文件内容都用它。
// windowOf 是纯算术，好单独测；useVirtual 把它接到一个能滚的元素上。
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

export interface RowWindow {
  /** 要画的第一行（从 0 起） */
  first: number
  /** 要画到哪一行为止（不含） */
  last: number
}

/** 滚到 top、能看见 height 这么高的时候，要画哪些行。上下各多画 overscan 行，滚动时不露白 */
export function windowOf(
  top: number,
  height: number,
  rowHeight: number,
  count: number,
  overscan: number,
): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { first: 0, last: 0 }
  const from = Math.floor(Math.max(top, 0) / rowHeight)
  const visible = Math.ceil(Math.max(height, 0) / rowHeight) + 1
  const first = Math.min(Math.max(from - overscan, 0), Math.max(count - 1, 0))
  const last = Math.min(count, from + visible + overscan)
  return { first, last: Math.max(last, first) }
}

/**
 * 要让第 index 行看得见，该滚到哪。已经看得见就返回 null（不动）。
 * align 是 nearest：从哪边出去的就贴哪边；是 lead：把它放在离顶三分之一的地方（定位到某一行时用）
 */
export function scrollTopFor(
  index: number,
  top: number,
  height: number,
  rowHeight: number,
  align: 'nearest' | 'lead',
): number | null {
  const rowTop = index * rowHeight
  if (align === 'lead') return Math.max(0, Math.round(rowTop - height / 3))
  if (rowTop < top) return rowTop
  if (rowTop + rowHeight > top + height) return Math.max(0, rowTop + rowHeight - height)
  return null
}

export interface Virtual extends RowWindow {
  scroller: RefObject<HTMLDivElement | null>
  /**
   * 接在能滚的元素的 onScroll 上。当场重画：滚动事件是在这一帧画出来之前到的，等到下一帧再画的话，
   * 一下子滚得远（拖滚动条）的那一帧，看得见的地方会是空的
   */
  onScroll(): void
  /** 自己改了滚动位置之后（在布局阶段里）对一下。不能在那里用 onScroll：那时候不许当场重画 */
  sync(): void
  /** 让第 index 行看得见 */
  show(index: number, align?: 'nearest' | 'lead'): void
}

export function useVirtual(count: number, rowHeight: number, overscan = 12): Virtual {
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 0 })

  const measure = useCallback(() => {
    const element = scroller.current
    if (!element) return
    const top = element.scrollTop
    const height = element.clientHeight
    setView((before) =>
      // 还在同一行里滚、高度也没变：要画的行不变，不用重画
      Math.floor(before.top / rowHeight) === Math.floor(top / rowHeight) && before.height === height
        ? before
        : { top, height },
    )
  }, [rowHeight])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  const onScroll = useCallback(() => flushSync(measure), [measure])

  const show = useCallback(
    (index: number, align: 'nearest' | 'lead' = 'nearest') => {
      const element = scroller.current
      if (!element || index < 0) return
      const next = scrollTopFor(index, element.scrollTop, element.clientHeight, rowHeight, align)
      if (next === null) return
      element.scrollTop = next
      measure()
    },
    [rowHeight, measure],
  )

  return {
    scroller,
    ...windowOf(view.top, view.height, rowHeight, count, overscan),
    onScroll,
    sync: measure,
    show,
  }
}
