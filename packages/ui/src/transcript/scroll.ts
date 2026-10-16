// 对话区的滚动。目标是“不飘”：内容在变，用户眼前的东西不动。
//
// 滚动容器用反向列布局：滚动位置是“离底部多远”，内容在底部增长时浏览器自己保持这个距离，
// 所以贴在底部时不需要任何脚本，也就没有慢一帧的抖动。
// 用户往上滚离了底部之后，“离底部的距离不变”反而会让眼前的内容被新内容顶走，这时由这里补偿。
//
// 办法：盯住视口里最靠上和最靠下的两行，记下它们各自“上边缘到内容底边”有多远。
// 这个量只跟排版有关，跟滚动位置无关，所以用户自己滚、我们自己补偿都不会把它弄乱。
// 内容一变就重新量，看两行各变了多少：
// - 变得一样多：变化在视口下面。离底部的距离跟着加减这么多，视口里什么都不动。
// - 上面那行变得更多：视口里有东西长出来了。盯住上面那行，下面的被推下去。
// - 上面那行变得更少：视口里有东西收起来了（活动区自动收起）。盯住下面那行，上面的滑下来，
//   这样正在看的最终回答不跳。
// 三种情况合起来就是：取两个变化量里较大的那个。
// 点开或收起一个条目时盯住的是被点的那一行，办法一样。
// 浏览器自带的滚动锚定已经在样式里关掉了（overflow-anchor: none），不然会补偿两次。
//
// 换皮肤、明暗、密度、界面缩放是另一回事：整页的字体、行高、宽度一起变，视口里每一行都在变高变矮。
// 照“取较大的那个”算，变矮的时候盯的是下面那行，来回换几次，眼前的内容就一截一截往下溜。
// 所以外观一变，就改成一直盯住最靠上的那一行（人正读着的地方），盯到新字体到齐、版面定下来为止。
// 这时候盯的是它在屏幕上的位置（上边缘在窗口里的纵坐标），不是它到内容底边的距离：
// 输入区的高度也会跟着皮肤变，视口自己变高变矮的那几个像素也要算进去。
// 这一阵子里用户自己滚了，就不再盯，照他滚到的地方来。
//
// 补不了的情况：收起的高度比下面剩的内容还多（比如贴着底部收起一大块），滚动位置已经到头了，
// 那一行只能跟着下来。要彻底不动得在底部垫一块留白，这个放在后面做。
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { onAppearanceChange } from '../app/appearance.ts'

/** 离底部不超过这么多像素算“在底部” */
const AT_BOTTOM = 1
/**
 * 外观变了之后至少盯住最靠上的那一行这么久。新皮肤的字体是样式重算之后才去取的，到了还要再排一次版；
 * 缩放要经外壳走一趟，来得更晚一些
 */
const STEADY_MS = 500

interface Hold {
  element: Element
  /** 它的上边缘到内容底边的距离。只跟排版有关，滚动不会改变它 */
  fromBottom: number
}

interface Steady {
  element: Element
  top: number
  scrollTop: number
}

/** rows 里从头数，连续满足条件的有多少个。条件必须是“前一段都满足、后一段都不满足” */
function countWhile(rows: NodeListOf<Element>, test: (row: Element) => boolean): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    const row = rows[middle]
    if (row && test(row)) low = middle + 1
    else high = middle
  }
  return low
}

/** 离开一个会话时记下的位置。回来时按它恢复 */
type Saved = { follow: true } | { follow: false; anchor: string; offset: number; distance: number }

const saved = new Map<string, Saved>()

export interface TranscriptScroll {
  scrollerRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  /** 是否贴在底部。不在底部时显示“回到底部” */
  following: boolean
  toBottom(): void
  /** 内容第一次画出来之后调用一次：回到上次离开这个会话时的位置。调用之后才开始记这个会话的位置 */
  restore(): void
  /** 交给点击处理函数用：接下来这次布局变化里，让这个元素在屏幕上不动 */
  pin(element: Element | null): void
}

export function useTranscriptScroll(sessionKey: string): TranscriptScroll {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const follow = useRef(true)
  /** 视口里最靠上、最靠下的两行，以及刚被点过的那一行 */
  const upper = useRef<Hold | null>(null)
  const lower = useRef<Hold | null>(null)
  const pinned = useRef<Hold | null>(null)
  /** 视口里最靠上的那一行，上边缘在窗口里的纵坐标。和 upper 一起记 */
  const upperTop = useRef(0)
  /**
   * 外观正在变的这一阵子盯住的那一行（变之前视口里最靠上的）：它的上边缘该在的纵坐标，
   * 和我们最后一次摆好之后的滚动位置（滚动位置和它对不上，就是用户自己滚了）
   */
  const steadied = useRef<Steady | null>(null)
  /** 上一次改滚动位置时想要的值，和浏览器实际给的值 */
  const written = useRef<{ wanted: number; given: number } | null>(null)
  /** 现在显示的是哪个会话，以及它的内容是不是已经画出来、位置恢复过了 */
  const shown = useRef(sessionKey)
  const armed = useRef(false)

  // 换了一个会话：盯住的行全部作废，并且先停止记位置。
  // 新会话的内容可能要等一会儿才到，这段时间里滚动容器是空的；这时候要是照常记，
  // 就会把“在底部”记到新会话名下，把它上次离开时的位置盖掉
  useLayoutEffect(() => {
    shown.current = sessionKey
    armed.current = false
    upper.current = null
    lower.current = null
    pinned.current = null
    steadied.current = null
    written.current = null
    if (!follow.current) {
      follow.current = true
      setFollowing(true)
    }
  }, [sessionKey])

  const hold = useCallback((element: Element | null | undefined): Hold | null => {
    const content = contentRef.current
    if (!content || !element) return null
    const fromBottom = content.getBoundingClientRect().bottom - element.getBoundingClientRect().top
    return { element, fromBottom }
  }, [])

  /** 盯住的这一行下面的内容变高了多少。这一行已经不在页面里时没有答案 */
  const grown = useCallback(
    (held: Hold | null): number | null => {
      if (!held?.element.isConnected) return null
      const now = hold(held.element)
      return now ? now.fromBottom - held.fromBottom : null
    },
    [hold],
  )

  /** 离底部再远这么多像素（负数是靠近） */
  const shift = useCallback((delta: number) => {
    const scroller = scrollerRef.current
    if (!scroller || Math.abs(delta) < 0.01) return
    // 浏览器会把滚动位置取整到设备像素。接着“上次想要的值”往下算，取整的误差才不会越积越多；
    // 上次之后用户自己滚过，就以现在的实际位置为准
    const last = written.current
    const from = last && scroller.scrollTop === last.given ? last.wanted : scroller.scrollTop
    const wanted = from - delta
    scroller.scrollTop = wanted
    const given = scroller.scrollTop
    // 差得多说明滚到头被卡住了，想要的值作废
    written.current = { wanted: Math.abs(given - wanted) > 1 ? given : wanted, given }
  }, [])

  /** 把排版变化造成的移动补回去 */
  const compensate = useCallback(() => {
    if (!armed.current) return
    const pin = pinned.current
    // 外观正在变：把盯着的那一行放回它在屏幕上原来的位置（它要是已经不在页面里了，就照平时的算）。
    // 刚点过的那一行优先
    const steady = steadied.current
    const scroller = scrollerRef.current
    if (!pin && steady?.element.isConnected && scroller) {
      const drift = steady.element.getBoundingClientRect().top - steady.top
      // 不到半个像素的不追：滚动位置会被取整到设备像素，追它只会来回抖
      if (Math.abs(drift) >= 0.5) {
        scroller.scrollTop += drift
        steady.scrollTop = scroller.scrollTop
        written.current = null
      }
      return
    }
    if (pin) {
      const delta = grown(pin)
      if (delta === null) return
      shift(delta)
      pin.fromBottom += delta
      return
    }
    if (follow.current) return
    const deltas = [grown(upper.current), grown(lower.current)].filter((delta) => delta !== null)
    if (deltas.length > 0) shift(Math.max(...deltas))
  }, [grown, shift])

  /** 重新认一下现在在不在底部、视口里最靠上和最靠下的是哪两行，并记下来 */
  const observe = useCallback(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content || !armed.current) return
    const distance = -scroller.scrollTop
    const atBottom = distance <= AT_BOTTOM
    if (atBottom !== follow.current) {
      follow.current = atBottom
      setFollowing(atBottom)
    }
    if (atBottom) {
      upper.current = null
      lower.current = null
      saved.set(shown.current, { follow: true })
      return
    }
    const view = scroller.getBoundingClientRect()
    // 带标记的行互不重叠、从上到下排列，所以可以二分
    const rows = content.querySelectorAll('[data-anchor]')
    // 第一个还没完全滚出上边缘的，和最后一个已经露出下边缘的
    const first = countWhile(rows, (row) => row.getBoundingClientRect().bottom <= view.top)
    const last = countWhile(rows, (row) => row.getBoundingClientRect().top < view.bottom) - 1
    upper.current = hold(rows[first])
    lower.current = last > first ? hold(rows[last]) : null
    const element = upper.current?.element
    if (!element) return
    upperTop.current = element.getBoundingClientRect().top
    saved.set(shown.current, {
      follow: false,
      anchor: element.getAttribute('data-anchor') ?? '',
      offset: upperTop.current - view.top,
      distance,
    })
  }, [hold])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    // 先补偿、再重新认位置，这个顺序不能反：滚动事件到的时候，这一帧的排版可能已经变了，
    // 直接认位置会把“被顶走之后的位置”当成该守住的位置，这一次变化就永远补不回来了
    const update = () => {
      compensate()
      observe()
    }
    // 尺寸变化的回调在布局之后、上屏之前执行，所以补偿不会被看见
    const resize = new ResizeObserver(update)
    resize.observe(content)
    // 视口自己变大变小（拖窗口）时，最靠上、最靠下的行会换，也要重新认
    resize.observe(scroller)
    const scrolled = () => {
      // 外观正在变的时候用户自己滚了（滚动位置不是我们摆的那个）：不再盯着那一行
      const steady = steadied.current
      if (steady && scroller.scrollTop !== steady.scrollTop) steadied.current = null
      update()
    }
    scroller.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      resize.disconnect()
      scroller.removeEventListener('scroll', scrolled)
    }
  }, [compensate, observe])

  // 外观变了：盯住变之前视口里最靠上的那一行。贴在底部的时候没有要盯的，照旧由反向列布局自己保持。
  // 这里只是换一下“盯谁”，不读版面：属性刚换、版面还没重排，记着的距离都还是换之前的，正好拿来比
  useEffect(
    () =>
      onAppearanceChange(() => {
        const scroller = scrollerRef.current
        if (!scroller || !upper.current || follow.current) return
        // 连着换（上一次的还没定下来）：接着盯原来那一行、原来的位置，不重新认，免得一次次认出来的零头越积越多
        const kept = steadied.current
        const held: Steady = kept?.element.isConnected
          ? { ...kept }
          : { element: upper.current.element, top: upperTop.current, scrollTop: scroller.scrollTop }
        steadied.current = held
        const since = performance.now()
        const release = () => {
          if (steadied.current === held) steadied.current = null
        }
        // 先过一帧（样式重算了，字体才开始取），等字体到齐，凑够时间，再过两帧让版面定下来
        requestAnimationFrame(() => {
          void document.fonts.ready.then(() => {
            const rest = Math.max(0, STEADY_MS - (performance.now() - since))
            setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(release)), rest)
          })
        })
      }),
    [],
  )

  const toBottom = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTop = 0
    written.current = null
    observe()
  }, [observe])

  const restore = useCallback(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const state = saved.get(sessionKey)
    const target =
      state && !state.follow
        ? content.querySelector(`[data-anchor="${CSS.escape(state.anchor)}"]`)
        : null
    if (!state || state.follow) {
      // 滚动容器是几个会话共用的，上一个会话滚到哪儿还留着：没有记录就回到底部
      scroller.scrollTop = 0
    } else if (target) {
      const viewTop = scroller.getBoundingClientRect().top
      scroller.scrollTop += target.getBoundingClientRect().top - viewTop - state.offset
    } else {
      // 那一行不在了：退而求其次，回到离底部同样远的地方
      scroller.scrollTop = -state.distance
    }
    written.current = null
    // 从这一刻起才开始记这个会话的位置
    armed.current = true
    observe()
  }, [sessionKey, observe])

  const pin = useCallback(
    (element: Element | null) => {
      const held = hold(element)
      if (!held) return
      pinned.current = held
      // 布局变化发生在紧接着的这一两帧里；过了就不再盯着
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (pinned.current === held) pinned.current = null
        }),
      )
    },
    [hold],
  )

  return useMemo(
    () => ({ scrollerRef, contentRef, following, toBottom, restore, pin }),
    [following, toBottom, restore, pin],
  )
}

const PinContext = createContext<(element: Element | null) => void>(() => {})

export const PinProvider = PinContext.Provider

/** 条目的折叠开关在改状态之前先调它，把自己那一行钉住 */
export const usePin = () => useContext(PinContext)
