import type { AutomationPreviewView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { createAutomationPointer } from './pointer-renderer.ts'
import './preview.css'

export function PreviewTab({ place, shown }: SideTabProps) {
  const t = useT(),
    { channel } = useServices()
  const [view, setView] = useState<AutomationPreviewView | null>(null)
  const [error, setError] = useState(''),
    [now, setNow] = useState(Date.now())
  const pinned = view?.pinned ?? false
  const stage = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const frame = view?.frame ?? null
  const pointer = useRef<ReturnType<typeof createAutomationPointer> | null>(null)
  const owner = { deviceId: place.deviceId, sessionId: place.sessionId ?? '' }
  useEffect(() => {
    setView(null)
    setError('')
    if (!shown || !place.sessionId) return
    const clock = setInterval(() => setNow(Date.now()), 500)
    const stop = channel.subscribe(
      { kind: 'automationPreview', deviceId: place.deviceId, sessionId: place.sessionId },
      {
        snapshot: setView,
        delta: () => {},
        error: (e) => setError(e.message),
      },
    )
    return () => {
      stop()
      clearInterval(clock)
    }
  }, [channel, shown, place.deviceId, place.sessionId])
  useEffect(() => {
    if (!stage.current || !view?.surface || !view.frame || pinned) {
      pointer.current?.dispose()
      pointer.current = null
      return
    }
    const surface = view.surface,
      frame = view.frame
    if (!pointer.current)
      pointer.current = createAutomationPointer(stage.current, {
        surface,
        frame,
        // 写成变量引用：光标在宿主的影子树里，变量会继承进去，换皮肤、换深浅时跟着变（取一次值会停在当时的颜色）
        color: 'var(--accent)',
        outlineColor: 'var(--on-accent)',
        reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      })
    pointer.current.geometry(surface, frame)
    if (view.pointer) void pointer.current.update(view.pointer)
  }, [view, pinned])
  useEffect(() => {
    if (!shown || !place.sessionId || !place.deviceId) return
    return () => {
      pointer.current?.dispose()
      pointer.current = null
    }
  }, [shown, place.sessionId, place.deviceId])
  useEffect(() => {
    if (!frame || !image.current || pinned || !place.sessionId) return
    let live = true
    // 相同 JPEG 的下一帧不会再次触发 img.onload；decode 也覆盖缓存命中。
    void image.current
      .decode()
      .then(() => {
        if (live)
          return channel.command('automationPreview.control', {
            deviceId: place.deviceId,
            sessionId: place.sessionId ?? '',
            action: 'ack',
            streamId: frame.streamId,
            seq: frame.seq,
          })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [frame, pinned, channel, place.deviceId, place.sessionId])
  const control = async (action: 'stop' | 'takeover' | 'pin' | 'unpin') => {
    try {
      setError('')
      await channel.command('automationPreview.control', { ...owner, action })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  if (!place.sessionId || !view)
    return <div className="side-none dim">{error || t('automation.none')}</div>
  // 一行状态：后台操作、已切到前台、等空闲、等画面、出错；出错的用出错色，等的用等待色
  const notice: { text: string; tone: 'err' | 'wait' | null } | null =
    view.status === 'waitingForIdle'
      ? { text: t('automation.waiting'), tone: 'wait' }
      : view.status === 'capturePending'
        ? { text: t('automation.capture.pending'), tone: 'wait' }
        : view.status === 'captureDenied'
          ? { text: t('automation.capture.denied'), tone: 'err' }
          : ['captureFailed', 'interrupted'].includes(view.status)
            ? { text: t('automation.capture.failed'), tone: 'err' }
            : view.status === 'restoreFailed'
              ? { text: t('automation.restoreFailed'), tone: 'err' }
              : null
  return (
    <section className="automation-preview" data-automation-preview>
      <header className="automation-head">
        <span className="automation-app">{view.app}</span>
        <span className="dim">{t('automation.local')}</span>
      </header>
      <p className="automation-mode" role="status" data-foreground={view.foreground}>
        {view.foreground ? t('automation.foreground') : t('automation.background')}
      </p>
      {notice ? (
        <p
          className="automation-notice"
          data-tone={notice.tone}
          role={notice.tone === 'err' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="automation-stage" ref={stage}>
        {frame && !pinned ? (
          <img
            ref={image}
            alt={t('automation.image')}
            src={`data:image/jpeg;base64,${frame.data}`}
          />
        ) : (
          <span className="dim">{t(pinned ? 'automation.pinned' : 'automation.waitFrame')}</span>
        )}
      </div>
      {frame && !pinned && now - frame.receivedAt > 2000 && (
        <p className="automation-stale dim">{t('automation.stale')}</p>
      )}
      <div className="automation-controls">
        <button type="button" className="btn" onClick={() => void control('stop')}>
          {t('automation.stop')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!view.surface}
          title={!view.surface ? t('automation.waitFrame') : undefined}
          onClick={() => void control('takeover')}
        >
          {t('automation.takeover')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!view.surface}
          title={!view.surface ? t('automation.waitFrame') : undefined}
          onClick={() => void control(pinned ? 'unpin' : 'pin')}
        >
          {t(pinned ? 'automation.unpin' : 'automation.pin')}
        </button>
      </div>
      {error && (
        <p className="automation-notice" data-tone="err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
