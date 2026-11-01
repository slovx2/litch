import { useLayoutEffect, useRef, useState } from 'react'
import type { ManagerActivityView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { Relations } from './Relations.tsx'

export function Activity({
  activity,
  deviceId,
}: {
  activity: ManagerActivityView
  deviceId: string
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [long, setLong] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const source = activity.source ?? { kind: 'system' as const }
  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const measure = () =>
      setLong(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 5 + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [])
  return (
    <article className="mg-activity" data-activity={activity.id}>
      <header>
        {source.kind === 'line' ? (
          <button
            type="button"
            className="pill mute mg-activity-source"
            onClick={() => requestOpenSession({ deviceId, sessionId: source.threadId })}
          >
            {t('manager.source.line')} · {source.title} <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <span className="pill mute">{t(`manager.source.${source.kind}`)}</span>
        )}
        <Stamp className="dim" at={activity.at} />
      </header>
      {source.kind === 'line' ? <Relations id={source.threadId} kind="thread" reverse /> : null}
      <div className="mg-activity-content" data-expanded={expanded} ref={body}>
        <BoardMarkdown text={activity.text} />
      </div>
      {long ? (
        <button
          type="button"
          className="btn ghost"
          aria-expanded={expanded}
          data-act="manager-activity-expand"
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'manager.activityCollapse' : 'manager.activityExpand')}
        </button>
      ) : null}
    </article>
  )
}
