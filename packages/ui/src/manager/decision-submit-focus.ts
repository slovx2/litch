/** 按提交前的显示顺序，从首条成功答复之后继续；跳过同批成功项与已在别处结束的决策。 */
export function nextPendingDecision(
  before: readonly string[],
  accepted: readonly string[],
  pending: readonly string[],
): string | null {
  const answered = new Set(accepted)
  const start = before.findIndex((id) => answered.has(id))
  if (start < 0) return null
  const remaining = new Set(pending)
  return before.slice(start + 1).find((id) => !answered.has(id) && remaining.has(id)) ?? null
}

/** 不让 focus 自行滚动；只在下一项或列表头不可见时移动到它，避免把整个页面拉到顶端。 */
export function focusDecisionAfterSubmit(element: HTMLElement): void {
  element.focus({ preventScroll: true })
  // 卡片可能高过整个列表视口；滚动标题，避免只露出下一张卡片的中段。
  const heading = element.querySelector('header') ?? element
  heading.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
}
