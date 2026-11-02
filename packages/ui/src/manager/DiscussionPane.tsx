// 看板底部的讨论分屏：一次只开一个帖子的讨论，内容由那张卡片下的讨论组件用 portal 放进来。
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../app/appearance.ts'
import { Close } from '../app/icons.tsx'
import {
  PANE_LIST_MIN,
  PANE_MIN,
  paneHeightNow,
  setPaneHeight,
  usePaneHeight,
} from './discussion-pane.ts'

export function DiscussionPane({
  id,
  title,
  onHost,
  onBack,
  onClose,
}: {
  id: string
  title: string
  onHost(element: HTMLElement | null): void
  onBack(): void
  onClose(): void
}) {
  const t = useT()
  const height = usePaneHeight()
  // 能拖到多高看看板此刻的高度：上面的卡片列表至少留 PANE_LIST_MIN
  const limit = (pane: HTMLElement | null) => {
    const board = pane?.closest<HTMLElement>('.mg-board')
    const body = board?.querySelector<HTMLElement>('.mg-body')
    if (!board || !body || !pane) return Number.POSITIVE_INFINITY
    return pane.offsetHeight + body.offsetHeight - PANE_LIST_MIN
  }
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const pane = grip.parentElement
    const y = event.clientY
    const start = pane?.offsetHeight ?? paneHeightNow()
    const max = limit(pane)
    grip.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => setPaneHeight(Math.min(max, start + y - next.clientY))
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
    event.preventDefault()
  }
  return (
    <section
      className="mg-talk-pane"
      data-post={id}
      aria-label={t('manager.discussionOf', { title })}
      style={{ '--mg-talk-h': `${height}px` } as CSSProperties}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 可拖动及键盘调整的分隔条。 */}
      <div
        className="mg-talk-grip"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-label={t('manager.resizeDiscussion')}
        aria-valuemin={PANE_MIN}
        aria-valuenow={height}
        onPointerDown={drag}
        onKeyDown={(event) => {
          const pane = event.currentTarget.parentElement
          const current = pane?.offsetHeight ?? height
          const next = {
            ArrowUp: current + 24,
            ArrowDown: current - 24,
            Home: PANE_MIN,
            End: limit(pane),
          }[event.key]
          if (next === undefined) return
          event.preventDefault()
          setPaneHeight(Math.min(limit(pane), next))
        }}
      />
      <header className="mg-talk-head">
        <button
          type="button"
          className="mg-talk-title ell"
          data-act="discussion-back"
          title={t('manager.discussionBack')}
          onClick={onBack}
        >
          <span className="mono dim">{id}</span> {title}
        </button>
        <button
          type="button"
          className="ibtn"
          data-act="discussion-close"
          aria-label={t('manager.discussionClose')}
          title={t('manager.discussionClose')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="mg-talk-body" ref={onHost} />
    </section>
  )
}
