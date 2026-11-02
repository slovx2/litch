// 议题在别处答复、关闭、忽略或取消后，本地草稿还在但不计数、不提交：卡片上一行说明，可查看或丢弃。
import { type ReactNode, useState } from 'react'
import { useT } from '../app/appearance.ts'

export function DraftEnded({
  text,
  disabled,
  onDiscard,
  children,
}: {
  text: string
  disabled?: boolean
  onDiscard(): void
  children: ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="mg-draft-ended" role="status" data-draft-ended>
      <p>{text}</p>
      <div className="mg-actions">
        <button
          type="button"
          className="btn ghost"
          data-act="manager-draft-view"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'manager.draftHide' : 'manager.draftView')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="manager-draft-discard"
          disabled={disabled}
          onClick={onDiscard}
        >
          {t('manager.draftDiscard')}
        </button>
      </div>
      {open ? (
        <div className="mg-draft-preview" data-draft-preview>
          {children}
        </div>
      ) : null}
    </div>
  )
}
