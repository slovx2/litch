// Portal 浮层按实际尺寸定位；字号、窗口和内容变化后重新量，不能用默认字号的宽高猜边界。
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react'

export function useCommentPosition(
  anchor: DOMRect | null,
  side: 'above' | 'below',
  target?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const left = anchor?.left
  const top = anchor?.top
  const bottom = anchor?.bottom
  useLayoutEffect(() => {
    const element = ref.current
    if (left === undefined || top === undefined || bottom === undefined || !element) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const current = target?.current?.getBoundingClientRect()
      const below = (current?.bottom ?? bottom) + 6
      const above = (current?.top ?? top) - height - 6
      const y =
        side === 'above'
          ? above >= 8
            ? above
            : below
          : below + height <= window.innerHeight - 8
            ? below
            : above
      setStyle({
        left: Math.max(8, Math.min(current?.left ?? left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [left, top, bottom, side, target])
  return { ref, style }
}
