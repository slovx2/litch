// 在文件上点右键出来的菜单：弹在鼠标那里，靠近窗口边沿时往回挪。
// 点到外面、按 Esc、面板一滚、窗口一失焦就收起；上下键在几项之间走，弹出来时焦点落在第一项上。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  id: string
  title: string
}

/** 菜单和窗口边沿之间留的空 */
const EDGE = 8

export function ContextMenu({
  x,
  y,
  label,
  items,
  onPick,
  onClose,
}: {
  x: number
  y: number
  /** 这份菜单是谁的（读屏用） */
  label: string
  items: MenuItem[]
  onPick(id: string): void
  /** 收起。refocus：是按 Esc 收的，焦点该还给叫它出来的那一处 */
  onClose(refocus: boolean): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState({ x, y })

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    setSpot({
      x: Math.max(EDGE, Math.min(x, window.innerWidth - element.offsetWidth - EDGE)),
      y: Math.max(EDGE, Math.min(y, window.innerHeight - element.offsetHeight - EDGE)),
    })
    element.querySelector<HTMLElement>('button')?.focus()
  }, [x, y])

  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return
      onClose(false)
    }
    const gone = () => onClose(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('blur', gone)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('blur', gone)
    }
  }, [onClose])

  return (
    <div
      ref={box}
      className="pick-pop down at"
      role="menu"
      aria-label={label}
      style={{ left: spot.x, top: spot.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
          return
        }
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
        if (!step) return
        event.preventDefault()
        event.stopPropagation()
        const buttons = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])]
        const at = buttons.indexOf(document.activeElement as HTMLElement)
        buttons[(at + step + buttons.length) % buttons.length]?.focus()
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="pick-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="pick-opt"
            data-action={item.id}
            onClick={() => {
              onClose(false)
              onPick(item.id)
            }}
          >
            <b>{item.title}</b>
          </button>
        ))}
      </div>
    </div>
  )
}
