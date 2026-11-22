import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

/** 归档历史和当前打开后被归档的会话用同一个恢复入口。 */
export function ArchiveBar({
  deviceId,
  sessionId,
  disabled,
  onBack,
  onRestoring,
  onRestored,
}: {
  deviceId: string
  sessionId: string
  disabled: boolean
  onBack?: () => void
  onRestoring?: (restoring: boolean) => void
  onRestored?: () => void
}) {
  const { channel } = useServices()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const preview = onBack !== undefined

  // 从列表打开历史时可直接按 Esc 返回，用 Tab 到操作按钮。
  useEffect(() => {
    if (preview) bar.current?.focus({ preventScroll: true })
  }, [preview])

  const restore = () => {
    setBusy(true)
    setFailure(null)
    onRestoring?.(true)
    channel.command('session.unarchive', { deviceId, sessionId }).then(
      () => {
        setBusy(false)
        onRestored?.()
      },
      (error: unknown) => {
        onRestoring?.(false)
        setBusy(false)
        setFailure(t('session.failed', { reason: reasonOf(error, t) }))
      },
    )
  }

  return (
    <>
      <div className="cmp off arch-bar" ref={bar} tabIndex={preview ? -1 : undefined}>
        <span className="pill mute">{t('archived.badge')}</span>
        <span className="grow">{t('archived.readOnly')}</span>
        {onBack ? (
          <button type="button" className="btn ghost" onClick={onBack}>
            {t('archived.back')}
          </button>
        ) : null}
        <button type="button" className="btn primary" disabled={disabled || busy} onClick={restore}>
          {t('archived.restore')}
        </button>
      </div>
      {failure ? (
        <div className="cmp-hint err" role="alert">
          {failure}
        </div>
      ) : null}
    </>
  )
}
