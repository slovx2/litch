// 信息卡：鼠标在一行上停一下，旁边浮出一张卡片，放这一行平时不值得占地方的细节（主机、路径这些）。
// 卡片只是给人看的，里面没有可以点的东西；鼠标可以移进去选字、复制。
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

/** 鼠标停多久才出卡片。划过去不算 */
const SHOW_AFTER = 350
/** 鼠标离开后多久收起。留一点时间，好让鼠标从行上移进卡片 */
const HIDE_AFTER = 160
/** 卡片和侧栏右边沿之间、卡片和窗口边沿之间留的空 */
const GAP = 8

interface Spot {
  top: number
  left: number
}

export interface HoverCard {
  /** 给那一行的外框：鼠标进出 */
  area: {
    onPointerEnter(event: PointerEvent<HTMLElement>): void
    onPointerLeave(): void
    onPointerDown(): void
  }
  /** 给那一行的按钮：键盘焦点落上来也出卡片 */
  anchor: {
    onFocus(event: FocusEvent<HTMLElement>): void
    onBlur(): void
    onKeyDown(event: KeyboardEvent<HTMLElement>): void
    'aria-describedby': string | undefined
  }
  /** 卡片本身，放在那一行旁边渲染就行，它自己会浮到最上面 */
  card: ReactNode
}

/** content 只在卡片要显示时才调用 */
export function useHoverCard(content: () => ReactNode): HoverCard {
  const id = useId()
  const [spot, setSpot] = useState<Spot | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const wait = (ms: number, then: () => void) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      then()
    }, ms)
  }
  const hide = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setSpot(null)
  }
  /** 卡片出在侧栏的右边、和这一行齐头：不盖住侧栏里的东西 */
  const show = (row: HTMLElement) => {
    const rect = row.getBoundingClientRect()
    const side = row.closest('.sb')?.getBoundingClientRect().right ?? rect.right
    setSpot({ top: rect.top, left: side + GAP })
  }

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  // 卡片显示着的时候，侧栏一滚、窗口一失焦，位置就不对了：直接收起。
  // 对话区自己在滚（正在出字）不算，那和这张卡片没关系
  const shown = spot !== null
  useEffect(() => {
    if (!shown) return
    const gone = () => setSpot(null)
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.sb')) gone()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', gone)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', gone)
    }
  }, [shown])

  // 靠近窗口底部的行：卡片往上挪，整张都留在窗口里
  useLayoutEffect(() => {
    if (!spot || !box.current) return
    const lowest = window.innerHeight - box.current.offsetHeight - GAP
    if (spot.top > lowest) setSpot({ ...spot, top: Math.max(GAP, lowest) })
  }, [spot])

  return {
    area: {
      onPointerEnter(event) {
        // 触摸屏上没有“停在上面”这回事
        if (event.pointerType !== 'mouse') return
        const row = event.currentTarget
        wait(SHOW_AFTER, () => show(row))
      },
      onPointerLeave: () => wait(HIDE_AFTER, hide),
      // 点下去是要做事（展开、收起、新建），卡片让开
      onPointerDown: hide,
    },
    anchor: {
      onFocus(event) {
        if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget)
      },
      onBlur: hide,
      onKeyDown(event) {
        if (event.key === 'Escape') hide()
      },
      'aria-describedby': spot ? id : undefined,
    },
    card: spot
      ? createPortal(
          <div
            ref={box}
            id={id}
            role="tooltip"
            className="info-card"
            style={{ top: spot.top, left: spot.left }}
            onPointerEnter={() => {
              if (timer.current !== null) clearTimeout(timer.current)
              timer.current = null
            }}
            onPointerLeave={() => wait(HIDE_AFTER, hide)}
          >
            {content()}
          </div>,
          document.body,
        )
      : null,
  }
}
