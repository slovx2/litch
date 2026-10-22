import { type ReactNode, useEffect, useRef } from 'react'

interface ConfirmProps {
  title: string
  note?: string
  /** 一句话说不完的（几件事、一条命令、一串原因）放在这里，排在 note 后面 */
  children?: ReactNode
  yes: string
  no: string
  /** “是”那个按钮的样子：danger 是做了找不回来、会打断什么的；primary 只是要人点头。默认 danger */
  tone?: 'danger' | 'primary'
  onYes(): void
  /** 取消、按 Esc、点到外面 */
  onClose(): void
}

/**
 * 做一件找不回来的事（或者要在别的机器上动手的事）之前再问一次：盖在窗口上的一个小对话框。
 * 一打开焦点在“取消”上：顺手按回车不会把事做了。
 */
export function Confirm({
  title,
  note,
  children,
  yes,
  no,
  tone = 'danger',
  onYes,
  onClose,
}: ConfirmProps) {
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
        {note ? <span>{note}</span> : null}
        {children}
        <div className="pick-ask-actions">
          {/* biome-ignore lint/a11y/noAutofocus: 对话框一打开焦点就该在里面，而且落在不做事的那个按钮上 */}
          <button type="button" className="btn ghost" autoFocus onClick={onClose}>
            {no}
          </button>
          <button type="button" className={`btn ${tone} confirm-yes`} onClick={onYes}>
            {yes}
          </button>
        </div>
      </div>
    </dialog>
  )
}
