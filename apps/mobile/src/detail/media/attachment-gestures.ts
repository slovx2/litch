import { imageTaps } from './image-taps'

export interface ImagePosition {
  x: number
  y: number
  scale: number
}
type Touch = { pageX: number; pageY: number }
const points = (touches: readonly Touch[]) => {
  const [a, b] = touches
  return a
    ? {
        x: b ? (a.pageX + b.pageX) / 2 : a.pageX,
        y: b ? (a.pageY + b.pageY) / 2 : a.pageY,
        distance: b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0,
        count: touches.length,
      }
    : null
}

/** 原生附件图片的手势状态；触点数改变时重新定基点，但整次多指操作都不能成为单击。 */
export function attachmentGestures(update: (position: ImagePosition) => void, close: () => void) {
  let value: ImagePosition = { x: 0, y: 0, scale: 1 }
  let start: (NonNullable<ReturnType<typeof points>> & { value: ImagePosition }) | null = null
  let moved = false
  let began = 0
  const apply = (next: ImagePosition) => {
    value = next
    update(next)
  }
  const taps = imageTaps(close, () => apply({ x: 0, y: 0, scale: value.scale > 1 ? 1 : 2.5 }))
  return {
    grant(touches: readonly Touch[]) {
      began = Date.now()
      const p = points(touches)
      moved = (p?.count ?? 0) > 1
      start = p ? { ...p, value: { ...value } } : null
      if (moved) taps.cancel()
    },
    add(touches: readonly Touch[]) {
      if (touches.length <= 1) return
      moved = true
      taps.cancel()
      const p = points(touches)
      start = p ? { ...p, value: { ...value } } : null
    },
    move(touches: readonly Touch[]) {
      const p = points(touches)
      if (!p || !start) return
      if (p.count !== start.count) {
        moved = true
        taps.cancel()
        start = { ...p, value: { ...value } }
        return
      }
      const dx = p.x - start.x,
        dy = p.y - start.y
      moved ||= p.count > 1 || Math.hypot(dx, dy) > 8
      if (!moved) return
      taps.cancel()
      apply({
        x: start.value.x + dx,
        y: start.value.y + dy,
        scale:
          p.count > 1
            ? Math.max(
                1,
                Math.min(8, (start.value.scale * p.distance) / Math.max(1, start.distance)),
              )
            : start.value.scale,
      })
    },
    release() {
      if (start && !moved && Date.now() - began < 500) taps.tap()
      else taps.cancel()
      start = null
    },
    cancel() {
      taps.cancel()
      start = null
    },
  }
}
