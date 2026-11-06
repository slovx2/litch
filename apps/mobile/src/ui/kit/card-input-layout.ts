/** 键盘焦点事件是全局的：尚未布局或属于另一窗口的输入框，不能驱动当前弹窗滚动。 */
export function viewportInput(
  field: { target: number; parentScrollViewTarget: number; layout: { height: number } } | null,
  viewport: number,
): { target: number; height: number } {
  'worklet'
  return viewport > 0 && field?.parentScrollViewTarget === viewport
    ? { target: field.target, height: field.layout.height }
    : { target: -1, height: 0 }
}

/** 输入框最多占视口减去上下内边距；长内容改在输入框内部滚动。 */
export function cardInputMaxHeight(viewport: number, preferred: number, minimum: number): number {
  return Math.min(preferred, Math.max(minimum, viewport - 16))
}

/** 已避让键盘的短卡片按完整输入框滚动，不能只把光标移到键盘上沿。 */
export function cardInputScroll({
  offset,
  viewportTop,
  viewportBottom,
  inputTop,
  inputHeight,
  caretY,
}: {
  offset: number
  viewportTop: number
  viewportBottom: number
  inputTop: number
  inputHeight: number
  caretY: number | null
}): number {
  const height = viewportBottom - viewportTop
  if (height <= 0 || inputHeight <= 0) return offset
  const padding = Math.min(8, Math.max(0, (height - inputHeight) / 2))
  const top = viewportTop + padding
  const bottom = viewportBottom - padding
  // 超过视口的多行框无法整个放下，保护当前编辑行；正常尺寸优先完整边框。
  const oversized = inputHeight > bottom - top
  const end = oversized
    ? inputTop + Math.min(inputHeight, Math.max(24, caretY ?? 24))
    : inputTop + inputHeight
  const start = oversized ? Math.max(inputTop, end - 24) : inputTop
  const delta = start < top ? start - top : end > bottom ? end - bottom : 0
  return Math.max(0, offset + delta)
}
