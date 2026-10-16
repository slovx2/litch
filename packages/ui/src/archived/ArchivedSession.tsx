import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Transcript } from '../transcript/Transcript.tsx'

interface ArchivedSessionProps extends Selection {
  /** 回到已归档对话的列表 */
  onBack(): void
  /** 恢复成了：它回到侧栏里，接着在平常的对话区里打开 */
  onRestored(selection: Selection): void
}

/**
 * 只读地看一个已归档的对话：内容和平常的对话区一样，下面不是输入区，而是一条说明“已归档”的栏，
 * 上面有“恢复”。不恢复就发不了消息。
 */
export function ArchivedSession({ deviceId, sessionId, onBack, onRestored }: ArchivedSessionProps) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const shelved = useKey<SessionSummary[] | null>(keys.archived(deviceId))
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const online = device?.connection === 'online'
  /** 正在恢复：这时它从已归档的表里消失是我们自己做的，不算“在别处没了” */
  const restoring = useRef(false)

  // 一打开焦点就落在这条栏上：按 Esc 回列表，Tab 一下就是“恢复”
  useEffect(() => {
    bar.current?.focus({ preventScroll: true })
  }, [])

  // 正看着的时候它在别处被恢复或者删掉了：这一页没有着落了，回到列表
  const gone = Array.isArray(shelved) && !shelved.some((summary) => summary.id === sessionId)
  useEffect(() => {
    if (gone && !restoring.current) onBack()
  }, [gone, onBack])

  // Esc 回到列表
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 开着大图：这一下 Esc 是关它的，不连带退回列表
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  const restore = () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    restoring.current = true
    channel.command('session.unarchive', { deviceId, sessionId }).then(
      () => onRestored({ deviceId, sessionId }),
      (error: unknown) => {
        restoring.current = false
        setBusy(false)
        setFailure(t('session.failed', { reason: reasonOf(error, t) }))
      },
    )
  }

  return (
    <Transcript
      deviceId={deviceId}
      sessionId={sessionId}
      footer={
        <div className="dock" style={wireStyle(device?.wire)}>
          <div className="dock-in">
            <div className="cmp off arch-bar" ref={bar} tabIndex={-1}>
              <span className="pill mute">{t('archived.badge')}</span>
              <span className="grow">{t('archived.readOnly')}</span>
              <button type="button" className="btn ghost" onClick={onBack}>
                {t('archived.back')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!online || busy}
                onClick={restore}
              >
                {t('archived.restore')}
              </button>
            </div>
            {failure ? <div className="cmp-hint err">{failure}</div> : null}
          </div>
        </div>
      }
    />
  )
}
