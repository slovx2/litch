// 提交条上的“下一个”展开后，把那张卡的卡头停在可视区顶部（找哪一个见 core 的 nextOpenDecision）。
import { reducedMotion, scrollHost } from './card-motion.ts'

/** 卡头离可视区顶端留的边距 */
export const PIN_MARGIN = 8

/** 让卡片顶端停在滚动容器顶部（留 PIN_MARGIN）；偏好减少动态时直接定位 */
export function pinToTop(card: HTMLElement): void {
  const host = scrollHost(card)
  if (!host) return
  const top =
    host.scrollTop +
    card.getBoundingClientRect().top -
    host.getBoundingClientRect().top -
    PIN_MARGIN
  host.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' })
}
