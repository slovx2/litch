import { keys, type SessionHistory } from '@litch/core'
import { useCallback, useEffect } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey, useServices } from '../app/services.tsx'
import { savedTurns, type TranscriptScroll } from './scroll.ts'

export function useOlderHistory(
  deviceId: string,
  sessionId: string,
  scroll: TranscriptScroll,
  count: number,
  drawn: number,
  searching: boolean,
  settled: boolean,
) {
  const { channel } = useServices()
  const history = useKey<SessionHistory>(keys.history(deviceId, sessionId))
  const restoring = !!history?.hasMore && (savedTurns(`${deviceId}:${sessionId}`) ?? 0) > count
  const load = useCallback(() => {
    if (!settled || !history?.hasMore || history.loading) return
    const root = scroll.contentRef.current
    const top = scroll.scrollerRef.current?.getBoundingClientRect().top ?? 0
    const anchor = [...(root?.querySelectorAll('[data-anchor]') ?? [])].find(
      (el) =>
        el.checkVisibility({ contentVisibilityAuto: true }) &&
        el.getBoundingClientRect().bottom > top,
    )
    // 重开时先补到旧锚点，不能把临时首屏里的某行锁成新的阅读位置。
    if (anchor && !restoring) scroll.keepReading(anchor)
    void channel.command('session.loadOlder', { deviceId, sessionId }).catch(() => {})
  }, [channel, deviceId, sessionId, history, scroll, restoring, settled])

  useEffect(() => {
    if (!settled || !history?.hasMore || history.loading || history.error || searching) return
    if (restoring) {
      load()
      return
    }
    if (drawn < count) return
    const scroller = scroll.scrollerRef.current
    const content = scroll.contentRef.current
    if (!scroller || !content) return
    const nearTop = () => {
      // 反向列的 scrollTop 为负数；初次贴底且内容够一屏时不提前拉远处历史。
      const distance = scroller.scrollHeight - scroller.clientHeight + scroller.scrollTop
      if (distance < 240 && scroller.scrollTop < -32) load()
    }
    scroller.addEventListener('scroll', nearTop, { passive: true })
    const resize = new ResizeObserver(nearTop)
    resize.observe(content)
    nearTop()
    return () => {
      scroller.removeEventListener('scroll', nearTop)
      resize.disconnect()
    }
  }, [history, restoring, searching, drawn, count, load, scroll, settled])
  return { history, load, restoring: restoring && !history?.error }
}

export function HistoryStatus({
  history,
  load,
}: {
  history: SessionHistory | undefined
  load(): void
}) {
  const t = useT()
  if (!history?.hasMore) return null
  return (
    <button
      type="button"
      className="history-more"
      onClick={load}
      disabled={history.loading}
      aria-busy={history.loading}
      title={history.error ? String(history.error) : undefined}
    >
      {t(
        history.error
          ? 'transcript.historyRetry'
          : history.loading
            ? 'transcript.historyLoading'
            : 'transcript.historyOlder',
      )}
    </button>
  )
}
