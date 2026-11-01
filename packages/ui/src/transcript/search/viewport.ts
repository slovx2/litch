import { searchText } from '@litch/core'
import { searchDOM } from './reveal.ts'

/** 只量已排版的可见条目；不为选择起点展开屏外 content-visibility。 */
export function viewportAnchor(root: HTMLElement | null, query = '') {
  const scroller = root?.parentElement
  if (!root || !scroller) return undefined
  const view = scroller.getBoundingClientRect()
  const bottom = Math.abs(scroller.scrollTop) < 4
  const middle = bottom ? view.bottom : (view.top + view.bottom) / 2
  let nearest: { itemId: string; start: number; distance: number } | undefined
  for (const el of root.querySelectorAll<HTMLElement>('[data-search-item]')) {
    if (
      el.parentElement?.closest('[data-search-item]') ||
      !el.checkVisibility({ contentVisibilityAuto: true })
    )
      continue
    const box = el.getBoundingClientRect()
    if (box.bottom < view.top || box.top > view.bottom) continue
    const matches = query ? searchDOM([el], query, Infinity) : []
    const visible = matches.filter((r) => {
      const rect = r.getBoundingClientRect()
      return rect.bottom >= view.top && rect.top <= view.bottom
    })
    const match = visible.sort(
      (a, b) =>
        Math.abs(a.getBoundingClientRect().top - middle) -
        Math.abs(b.getBoundingClientRect().top - middle),
    )[0]
    const distance = match
      ? Math.abs(match.getBoundingClientRect().top - middle)
      : 10000 + Math.abs(Math.max(box.top, Math.min(middle, box.bottom)) - middle)
    if (nearest && nearest.distance < distance) continue
    let start = bottom ? Infinity : 0
    if (match) {
      const prefix = document.createRange()
      prefix.selectNodeContents(el)
      prefix.setEnd(match.startContainer, match.startOffset)
      start = searchText(prefix.toString()).length
    }
    nearest = { itemId: el.dataset.searchItem!, start, distance }
  }
  return nearest ? { itemId: nearest.itemId, start: nearest.start } : undefined
}
