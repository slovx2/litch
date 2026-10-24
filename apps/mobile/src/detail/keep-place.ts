// 展开收起时被点的那一行不动（照桌面端往下展开）。对话区是倒置列表，“保持可见位置”拿视觉上最下面那一行当锚：
// 在被点的行和它下面之间插进几行（展开一组），或者被点的行自己变高（展开一步的细节），锚点不动，
// 被点的行连同它上面的内容整个被顶上去，看着是往上长。这里记下被点那一行的上沿离列表底边多远，
// 列表按新的行排好之后滚回去，让它的上沿还在原处，多出来的往下推。
// 列表的引用从 FlashList 给单元格的上下文里拿，不经对话区：对话区的滚动另有一套规矩（detail/Transcript.tsx）。
import type { FlashListRef } from '@shopify/flash-list'
import type { Row } from '../core/rows'

type List = Pick<
  FlashListRef<Row>,
  'props' | 'getLayout' | 'getFirstItemOffset' | 'getAbsoluteLastScrollOffset' | 'scrollToOffset'
>

/**
 * 一行的上沿离列表可见区底边多远（倒置列表里行的上沿在布局上是 y + 高，表头在布局的最前面）。
 * 这一行不在数据里、还没排过是 null
 */
export function topOf(list: List, key: string): number | null {
  const rows = list.props.data as readonly Row[] | null | undefined
  const index = rows ? rows.findIndex((row) => row.key === key) : -1
  if (index < 0) return null
  const layout = list.getLayout(index)
  if (!layout) return null
  return layout.y + layout.height + list.getFirstItemOffset() - list.getAbsoluteLastScrollOffset()
}

/** 视觉上紧挨在这一行下面的那一行（数据新的在前，是前一个）。没有是 null */
export function rowBelow(list: Pick<List, 'props'>, key: string): string | null {
  const rows = list.props.data as readonly Row[] | null | undefined
  const index = rows ? rows.findIndex((row) => row.key === key) : -1
  return index > 0 ? (rows?.[index - 1]?.key ?? null) : null
}

/** 让这一行的上沿回到离底边 top 的地方要滚到哪。这一行不在了是 null */
export function offsetFor(list: List, key: string, top: number): number | null {
  const now = topOf(list, key)
  if (now === null) return null
  return Math.max(0, list.getAbsoluteLastScrollOffset() + now - top)
}

/**
 * 做 change（展开、收起），并让 key 那一行的上沿留在原处。
 * 新的行在同一轮里就排好了（React 的同步更新，FlashList 在布局副作用里同步量完），微任务里先校正一次，赶在原生那边画出来之前；
 * 原生那边还会截短、滚动事件晚到，所以之后每帧再对一次，连着 STILL 帧位置都对、或者满了 FRAMES 帧就停
 */
export function keepPlace(list: List | null | undefined, key: string, change: () => void): void {
  const top = list ? topOf(list, key) : null
  change()
  if (!list || top === null) return
  /** 返回这一次滚了没有 */
  const fix = (): boolean => {
    const target = offsetFor(list, key, top)
    if (target === null) return false
    // 滚动事件回来之前列表记的还是旧偏移，会再滚一次同一个位置，不要紧；原生那边内容还没长高时滚到的位置会被截短，
    // 下一帧按真的偏移再滚（2026-10-24 模拟器上实测：第一次只滚到 600，要的是 625）
    if (Math.abs(target - list.getAbsoluteLastScrollOffset()) < 1) return false
    list.scrollToOffset({ offset: target, animated: false })
    return true
  }
  Promise.resolve().then(fix)
  let frames = 0
  let still = 0
  const next = () => {
    still = fix() ? 0 : still + 1
    if (++frames < FRAMES && still < STILL) requestAnimationFrame(next)
  }
  requestAnimationFrame(next)
}

/** 最多盯几帧（约半秒）：用户这时开始拖动也只多管这么一会儿 */
const FRAMES = 30
/** 连着这么多帧（约 0.1 秒）位置都对，就当排定了 */
const STILL = 6
