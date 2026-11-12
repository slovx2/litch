// 卡尾操作栏的吸底位置只用 CSS 计算：bottom = 批量栏高度 − 滚动区下内边距。
// sticky 的 bottom 从滚动区内容盒底边算起，下内边距由滚动区自己声明为 --mg-scroll-pad（见 manager.css）；
// 批量栏（.mg-send）也吸在底部，这里只把它的实际高度写成滚动区上的 --mg-send-h，卡尾就贴在它的上沿。
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react'
import { scrollHost } from './card-motion.ts'

/** 返回给批量栏用的 ref 回调；同时写入调用方自己的 ref，供定位草稿等原有逻辑使用 */
export function useBatchBarInset(
  own: RefObject<HTMLElement | null>,
): (bar: HTMLElement | null) => void {
  const [bar, setBar] = useState<HTMLElement | null>(null)
  const ref = useCallback(
    (element: HTMLElement | null) => {
      own.current = element
      setBar(element)
    },
    [own],
  )
  useLayoutEffect(() => {
    const host = bar ? scrollHost(bar) : null
    if (!bar || !host) return
    const update = () => host.style.setProperty('--mg-send-h', `${bar.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    return () => {
      observer.disconnect()
      host.style.removeProperty('--mg-send-h')
    }
  }, [bar])
  return ref
}
