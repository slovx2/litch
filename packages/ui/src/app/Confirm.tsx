import { useEffect, useRef } from 'react'

interface ConfirmProps {
  title: string
  note: string
  yes: string
  no: string
  onYes(): void
  /** 取消、按 Esc、点到外面 */
  onClose(): void
}

/**
 * 做一件找不回来的事之前再问一次：盖在窗口上的一个小对话框。
 * 一打开焦点在“取消”上：顺手按回车不会把事做了。
 */
export function Confirm({ title, note, yes, no, onYes, onClose }: ConfirmProps) {
  const dialog = useRef<HTMLDialogElement>(null)

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="modal confirm"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        // Esc 只关这个对话框，别让外面的 Esc 处理也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <div className="confirm-body">
        <b>{title}</b>
        <span>{note}</span>
        <div className="pick-ask-actions">
          {/* biome-ignore lint/a11y/noAutofocus: 对话框一打开焦点就该在里面，而且落在不做事的那个按钮上 */}
          <button type="button" className="btn ghost" autoFocus onClick={onClose}>
            {no}
          </button>
          <button type="button" className="btn danger confirm-yes" onClick={onYes}>
            {yes}
          </button>
        </div>
      </div>
    </dialog>
  )
}
