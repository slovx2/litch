import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import {
  BOARD_MIN,
  boardLayoutNow,
  boardLimit,
  setBoardLayout,
  shownBoardWidth,
  useBoardLayout,
} from './board-layout.ts'

export function BoardGrip({ page }: { page: RefObject<HTMLElement | null> }) {
  const t = useT()
  const { width } = useBoardLayout()
  const [room, setRoom] = useState(0)
  // 父容器的 ref 在子组件布局副作用之后才就绪，挂载完成后再观察宽度。
  useEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(() => setRoom(element.clientWidth))
    setRoom(element.clientWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [page])
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const x = event.clientX
    const start = shownBoardWidth(width, page.current?.clientWidth ?? room)
    grip.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) =>
      setBoardLayout({
        width: shownBoardWidth(start + x - next.clientX, page.current?.clientWidth ?? room),
      })
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
    event.preventDefault()
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动及键盘调整的分隔条。
    <div
      className="mg-board-grip"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={t('manager.resizeBoard')}
      aria-valuemin={BOARD_MIN}
      aria-valuemax={boardLimit(room)}
      aria-valuenow={shownBoardWidth(width, room)}
      onPointerDown={drag}
      onKeyDown={(event) => {
        const current = shownBoardWidth(boardLayoutNow().width, room)
        const next = {
          ArrowLeft: current + 24,
          ArrowRight: current - 24,
          Home: BOARD_MIN,
          End: boardLimit(room),
        }[event.key]
        if (next === undefined) return
        event.preventDefault()
        setBoardLayout({ width: shownBoardWidth(next, room) })
      }}
    />
  )
}
