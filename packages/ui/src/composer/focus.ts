import { type RefObject, useEffect } from 'react'

/** 焦点是不是在能打字的控件上 */
export const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * 人是不是正写着东西：这时候来了请求，卡片不能把焦点从他手里拿走。
 * 焦点在能打字的控件上就算，只有一种不算——会话的输入框空着（没有字，没有图，也没有别的附带项）：
 * 平时焦点就停在那里，那不是在写
 */
export const busyWriting = (active: Element | null): boolean => {
  if (!typing(active)) return false
  if (!(active instanceof HTMLTextAreaElement) || !active.classList.contains('cmp-text'))
    return true
  return (
    active.value !== '' || Boolean(active.closest('.cmp')?.querySelector('.cmp-att, .cmp-chip'))
  )
}

/**
 * 输入区一出现就把焦点拿过来：打开会话就能直接打字。
 * 正在别处打字的不打断；请求卡片正拿着焦点（等着按键作答）的也不从它手里拿
 */
export function useGrabFocus(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement
    if (typing(active) || active?.closest('.req')) return
    target.current?.focus({ preventScroll: true })
  }, [target])
}

/**
 * 请求卡片一出现就把焦点拿过来：来了审批、提问就能直接按键答。
 * 人正写着东西（见 busyWriting）的不打断：他写完自己过来，卡片就在输入框上面
 */
export function useCardFocus(card: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (busyWriting(document.activeElement)) return
    card.current?.focus({ preventScroll: true })
  }, [card])
}
