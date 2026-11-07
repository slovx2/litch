import { useEffect, useRef } from 'react'
import { useT } from './appearance.ts'
import { Close } from './icons.tsx'

interface ImageViewerProps {
  url: string
  /** 图片的名字，给读屏用 */
  label: string
  onClose(): void
}

/** 看大图：盖在整个窗口上面。Esc、点图片以外的地方、点关闭按钮都能关上 */
export function ImageViewer({ url, label, onClose }: ImageViewerProps) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const press = useRef<{ blank: boolean; x: number; y: number; moved: boolean } | null>(null)

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘上是 Esc 和里面的关闭按钮
    <dialog
      ref={dialog}
      className="viewer"
      aria-label={label}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onPointerDown={(event) => {
        press.current = {
          blank: event.target === event.currentTarget,
          x: event.clientX,
          y: event.clientY,
          moved: false,
        }
      }}
      onPointerMove={(event) => {
        const start = press.current
        if (start) start.moved ||= Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
      }}
      onPointerCancel={() => {
        press.current = null
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && press.current?.blank && !press.current.moved)
          onClose()
        press.current = null
      }}
    >
      <img src={url} alt={label} />
      <button
        type="button"
        className="ibtn viewer-x"
        title={t('viewer.close')}
        aria-label={t('viewer.close')}
        onClick={onClose}
      >
        <Close />
      </button>
    </dialog>
  )
}
