import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { useT } from './appearance.ts'
import { Toasts } from './toasts.tsx'

export type AuxiliaryPage = 'settings' | 'suggestions' | 'tasks'

/** 最近一次操作是鼠标（触控）还是键盘：鼠标打开的窗口不画初始焦点框，键盘打开照常画 */
let pointerLast = false
window.addEventListener(
  'pointerdown',
  () => {
    pointerLast = true
  },
  true,
)
window.addEventListener(
  'keydown',
  () => {
    pointerLast = false
  },
  true,
)

/** 原生模态层负责背景 inert 和焦点恢复；补齐 Tab 首尾循环，避免焦点落到窗口外壳。 */
export function PageWindow({
  kind,
  onClose,
  children,
}: {
  kind: AuxiliaryPage
  onClose(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const t = useT()
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    // 初始焦点放在当前分区上（设置），不落在排第一的“设备”上，免得看着像两个选中项
    element.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true })
    if (pointerLast) element.dataset.quietFocus = ''
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="page-window"
      data-page-window={kind}
      // 设置左右两栏切换时尺寸不跳，固定大小；建议和定时任务按内容定高
      data-fit={kind === 'settings' ? undefined : ''}
      aria-label={t(
        kind === 'settings'
          ? 'settings.title'
          : kind === 'tasks'
            ? 'tasks.title'
            : 'suggestions.title',
      )}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        // 内层确认框自己处理 Esc；其余按键不传给主窗口的全局快捷键。
        if ((event.target as Element).closest('dialog') !== event.currentTarget) return
        event.stopPropagation()
        // 一按键就恢复焦点框
        delete event.currentTarget.dataset.quietFocus
        if (event.key === 'Tab' && !event.defaultPrevented) {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button, a[href], input, textarea, select, [tabindex], [contenteditable="true"]',
            ),
          ].filter(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(':disabled, [inert]') &&
              element.getClientRects().length > 0,
          )
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault()
            last.focus({ preventScroll: true })
          } else if (!event.shiftKey && document.activeElement === last && first) {
            event.preventDefault()
            first.focus({ preventScroll: true })
          }
        }
        if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div className="page-window-content">{children}</div>
      <Toasts />
    </dialog>
  )
}
