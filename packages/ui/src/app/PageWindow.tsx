import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { useT } from './appearance.ts'
import { Toasts } from './toasts.tsx'

export type AuxiliaryPage = 'settings' | 'suggestions' | 'tasks'

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
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="page-window"
      data-page-window={kind}
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
