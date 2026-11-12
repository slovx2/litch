// 只由用户确认评论时触发；草稿恢复、发送失败回填和取消都不请求焦点。
const listeners = new Map<string, Set<() => void>>()

export function requestCommentFocus(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener()
}

export function onCommentFocus(key: string, listener: () => void): () => void {
  const group = listeners.get(key) ?? new Set<() => void>()
  listeners.set(key, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(key)
  }
}

/** 桌面评论确认后保留草稿原文，只将焦点与光标移到末尾。 */
export function focusCommentInput(
  input: {
    value: string
    focus(options: { preventScroll: boolean }): void
    setSelectionRange(start: number, end: number): void
  } | null,
): void {
  if (!input) return
  input.focus({ preventScroll: true })
  input.setSelectionRange(input.value.length, input.value.length)
}
