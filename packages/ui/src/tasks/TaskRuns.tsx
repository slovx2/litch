// 一个任务的运行记录：新的在前，往下翻页。打开着才去取（replica.openTaskRuns），之后的变化跟着通知改。
import { keys, type SessionSummary, type TaskRunsPage, type TaskRunView } from '@litch/core'
import { useEffect } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { errorText, runStatusText, runTone, triggerText, whenText } from './describe.ts'

function RunRow({
  run,
  onOpenSession,
}: {
  run: TaskRunView
  onOpenSession(selection: Selection): void
}) {
  const t = useT()
  const now = useNow()
  const session = useKey<SessionSummary>(keys.summary(run.deviceId, run.threadId ?? ''))
  const open = run.threadId && session
  return (
    <li
      className={run.read ? 'tk-run' : 'tk-run is-unread'}
      data-run={run.id}
      data-status={run.status}
    >
      <div className="tk-run-line">
        <span className="tk-st" data-tone={runTone(run.status)}>
          <i className="tk-dot" />
          {runStatusText(run.status, t)}
        </span>
        <span className="tk-run-when">{whenText(run.scheduledFor, now, t)}</span>
        <span className="chip">{triggerText(run.trigger, t)}</span>
        {run.coalesced > 0 ? (
          <span className="tk-run-more">{t('tasks.run.coalesced', { count: run.coalesced })}</span>
        ) : null}
        <span className="grow" />
        {open && run.threadId ? (
          <button
            type="button"
            className="btn ghost"
            data-act="open-run"
            onClick={() => onOpenSession({ deviceId: run.deviceId, sessionId: run.threadId ?? '' })}
          >
            {t('tasks.run.open')}
          </button>
        ) : (
          <span className="tk-run-more">
            {run.threadId
              ? t('tasks.run.gone')
              : run.status === 'queued'
                ? t('tasks.run.pending')
                : null}
          </span>
        )}
      </div>
      {run.summary ? <div className="tk-run-summary">{run.summary}</div> : null}
      {run.error ? <div className="tk-run-error">{errorText(run.error, t)}</div> : null}
    </li>
  )
}

export function TaskRuns({
  deviceId,
  taskId,
  onOpenSession,
}: {
  deviceId: string
  taskId: string
  onOpenSession(selection: Selection): void
}) {
  const { replica } = useServices()
  const page = useKey<TaskRunsPage>(keys.taskRuns(deviceId, taskId))
  const t = useT()
  useEffect(() => replica.openTaskRuns(deviceId, taskId), [replica, deviceId, taskId])
  const runs = page?.runs ?? []
  return (
    <section className="mng-sec tk-runs" data-sec="runs">
      <div className="mng-sec-head">
        <h2>{t('tasks.detail.runs')}</h2>
      </div>
      {page?.error ? (
        <div className="devp-note err">
          {t('tasks.failed', { reason: reasonOf(page.error, t) })}
        </div>
      ) : null}
      {runs.length === 0 && page && !page.loading && !page.error ? (
        <div className="devp-note">{t('tasks.detail.noRuns')}</div>
      ) : null}
      {runs.length > 0 ? (
        <ul className="tk-run-list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} onOpenSession={onOpenSession} />
          ))}
        </ul>
      ) : null}
      {!page || page.loading ? <div className="devp-note">{t('tasks.loading')}</div> : null}
      {page?.nextCursor && !page.loading ? (
        <div className="tk-more">
          <button
            type="button"
            className="btn ghost"
            data-act="more-runs"
            onClick={() => replica.moreTaskRuns(deviceId, taskId)}
          >
            {t('tasks.detail.more')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
