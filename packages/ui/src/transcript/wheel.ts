/** 只接管对话滚动容器的纵向位移，内部滚动区、弹窗和浏览器缩放仍走各自的处理。 */
export function transcriptWheel(scroller: HTMLElement, event: WheelEvent): number | null {
  if (
    event.defaultPrevented ||
    !event.cancelable ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return null
  if (!event.deltaY) return null

  for (const node of event.composedPath()) {
    if (node === scroller) break
    if (!(node instanceof HTMLElement)) continue
    if (node.matches('dialog, [role="dialog"]')) return null
    const style = getComputedStyle(node)
    // 斜向手势落在代码块或表格上时，浏览器会把整次滚动交给内层。
    // preventDefault 会同时取消两轴，不能只看纵向溢出而吞掉横向位移。
    // 横向到边缘后也保留原生归属，避免横滑里少量纵向噪声突然滚走对话。
    if (
      event.deltaX &&
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth - node.clientWidth > 1
    )
      return null
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
    const range = node.scrollHeight - node.clientHeight
    if (range <= 1) continue
    const canScroll = event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < range - 1
    if (
      canScroll ||
      style.overscrollBehaviorY === 'contain' ||
      style.overscrollBehaviorY === 'none'
    )
      return null
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * scroller.clientHeight
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const style = getComputedStyle(scroller)
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
    return event.deltaY * line
  }
  return event.deltaY
}
