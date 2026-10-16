// 把放网页的那块矩形报给外壳。网页是外壳叠在窗口最上层的一块原生视图，界面上的浮层（对话框、菜单、
// 信息卡、提示）盖不住它，所以有浮层压到这块矩形上时先把网页撤下来，浮层没了再放回去。
import { type RefObject, useEffect } from 'react'
import type { BrowserBridge } from './bridge.ts'

/** 会压到网页上的浮层。开着的模态对话框整个窗口都垫了底色，一律撤 */
const FLOATING = '[role="menu"], [role="listbox"], [role="tooltip"], [role="dialog"], .toasts > *'

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

function covered(box: DOMRect, own: HTMLElement): boolean {
  if (document.querySelector('dialog[open]')) return true
  for (const element of document.querySelectorAll<HTMLElement>(FLOATING)) {
    if (own.contains(element)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && overlaps(rect, box)) return true
  }
  return false
}

/**
 * tabId 有值时把 ref 那块矩形报给外壳显示这个标签，没有（面板收着、没有标签）时报“什么都不显示”。
 * 量的时机：元素或整页大小变了、页面结构变了（浮层出现、侧栏开合）、窗口变了，另外每半秒兜底一次
 */
export function usePlacement(
  bridge: BrowserBridge,
  tabId: string | null,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!tabId) {
      bridge.place(null, null)
      return
    }
    let last = ''
    let frame = 0
    const measure = () => {
      frame = 0
      const element = ref.current
      if (!element) return
      const box = element.getBoundingClientRect()
      const hide = box.width < 2 || box.height < 2 || covered(box, element)
      const rect = hide ? null : { x: box.left, y: box.top, width: box.width, height: box.height }
      const said = JSON.stringify(rect)
      if (said === last) return
      last = said
      bridge.place(rect ? tabId : null, rect)
    }
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const resize = new ResizeObserver(soon)
    if (ref.current) resize.observe(ref.current)
    resize.observe(document.documentElement)
    const mutations = new MutationObserver(soon)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'class', 'style'],
    })
    window.addEventListener('resize', soon)
    const timer = setInterval(soon, 500)
    return () => {
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', soon)
      clearInterval(timer)
      if (frame) cancelAnimationFrame(frame)
      bridge.place(null, null)
    }
  }, [bridge, tabId, ref])
}
