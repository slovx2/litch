import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import type { BrowserBridge, BrowserDownload, BrowserOwner } from './bridge.ts'

export function downloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function Downloads({ bridge, owner }: { bridge: BrowserBridge; owner: BrowserOwner }) {
  const t = useT()
  const [items, setItems] = useState<BrowserDownload[]>([])
  const downloads = bridge.downloads
  useEffect(() => {
    if (!downloads) return
    let alive = true
    const off = downloads.onChanged(setItems)
    void downloads.list().then((value) => {
      if (alive) setItems(value)
    })
    return () => {
      alive = false
      off()
    }
  }, [downloads])
  const mine = items.filter(
    (item) => item.owner.deviceId === owner.deviceId && item.owner.threadId === owner.threadId,
  )
  if (!downloads || !mine.length) return null
  const active = (item: BrowserDownload) => ['pending', 'receiving'].includes(item.status)
  const visible = [
    ...mine.filter(active).reverse(),
    ...mine
      .filter((item) => !active(item))
      .slice(-6)
      .reverse(),
  ]
  return (
    <section className="bw-downloads" aria-label={t('browser.downloads')} aria-live="polite">
      {visible.map((item) => (
        <section
          className="bw-download"
          key={item.id}
          data-download={item.id}
          data-status={item.status}
        >
          <b>{item.filename}</b>
          <span className="dim">
            {item.origin} ·{' '}
            {item.totalBytes === null
              ? t('browser.download.unknown')
              : downloadSize(item.totalBytes)}
          </span>
          <span>
            {t(`browser.download.${item.status}`)} · {downloadSize(item.receivedBytes)}
          </span>
          {item.status === 'pending' && (
            <>
              <span className="dim">{t('browser.download.note')}</span>
              <div className="req-actions">
                <button
                  type="button"
                  className="btn primary"
                  data-download-allow
                  onClick={() => void downloads.answer(item.id, true)}
                >
                  {t('browser.download.allow')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  data-download-decline
                  onClick={() => void downloads.answer(item.id, false)}
                >
                  {t('clientAsk.option.decline')}
                </button>
              </div>
            </>
          )}
          {item.status === 'completed' && (
            <>
              <span className="dim">{item.path}</span>
              <button
                type="button"
                className="btn"
                data-download-reveal
                onClick={() => downloads.reveal(item.id)}
              >
                {t('browser.download.reveal')}
              </button>
            </>
          )}
        </section>
      ))}
    </section>
  )
}
