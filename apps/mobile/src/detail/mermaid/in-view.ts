// 卡片在不在屏幕上：进了屏幕才去画图。列表会在屏幕外 1500dp 的范围里提前排好行，那些先不画。
// 卡片排好时量一次自己在窗口里的位置；对话区滚动时（滚停了，或者一直在滚时每隔一阵）再让各张卡片量一次。
// 不按列表的“可见项”算：倒置列表的可见项在网页预览里不回调，贴底时列表表头里的回答也不在可见项里。
// 不在对话区里的地方（没有这一层）算一直在屏幕上。
import { createContext, type RefObject, useCallback, useContext, useEffect, useState } from 'react'
import { Dimensions, type View } from 'react-native'

/** 滚停了多久算停 */
const QUIET_MS = 120
/** 一直在滚时，隔多久量一次 */
const EVERY_MS = 400

export class InView {
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private last = 0

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 对话区滚动了（交给列表的 onScroll） */
  readonly scrolled = (): void => {
    const now = Date.now()
    if (now - this.last >= EVERY_MS) this.tell(now)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tell(Date.now()), QUIET_MS)
  }

  private tell(now: number): void {
    this.last = now
    for (const listener of this.listeners) listener()
  }
}

export const InViewContext = createContext<InView | null>(null)

/**
 * ref 指的视图在不在屏幕上。onLayout 要接到这个视图上（排好、尺寸变了时量）；
 * again 变了（行被列表回收给别的内容）也重新量
 */
export function useInView(
  ref: RefObject<View | null>,
  again: unknown,
): { seen: boolean; measure(): void } {
  const view = useContext(InViewContext)
  const [seen, setSeen] = useState(view === null)
  const measure = useCallback(() => {
    if (!view) return
    ref.current?.measureInWindow((_x, y, _width, height) => {
      const screen = Dimensions.get('window').height
      setSeen(height > 0 && y < screen && y + height > 0)
    })
  }, [view, ref])
  useEffect(() => view?.subscribe(measure), [view, measure])
  // biome-ignore lint/correctness/useExhaustiveDependencies: again 只是重新量的时机
  useEffect(measure, [measure, again])
  return { seen, measure }
}
