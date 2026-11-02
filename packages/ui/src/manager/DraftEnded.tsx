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
  /** 点了“丢弃”，等再确认一次：丢了不能恢复 */
  const [discarding, setDiscarding] = useState(false)
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
        {discarding ? null : (
          <button
            type="button"
            className="btn ghost"
            data-act="manager-draft-discard"
            disabled={disabled}
            onClick={() => setDiscarding(true)}
          >
            {t('manager.draftDiscard')}
          </button>
        )}
      </div>
      {discarding ? (
        <div className="mg-draft-discard" data-draft-discard>
          <p>{t('manager.draftDiscardNote')}</p>
          <div className="mg-actions">
            <button type="button" className="btn ghost" onClick={() => setDiscarding(false)}>
              {t('manager.cancel')}
            </button>
            <button
              type="button"
              className="btn"
              data-act="manager-draft-discard-confirm"
              disabled={disabled}
              onClick={onDiscard}
            >
              {t('manager.draftDiscardConfirm')}
            </button>
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="mg-draft-preview" data-draft-preview>
          {children}
        </div>
      ) : null}
    </div>
  )
}
