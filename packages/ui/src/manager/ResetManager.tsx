import { useEffect, useRef, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

export function ResetManager({ manager, disabled }: { manager: ManagerView; disabled: boolean }) {
  const t = useT()
  const { channel } = useServices()
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const state = manager.reset
  const previousPhase = useRef(state?.phase)
  useEffect(() => {
    if (
      previousPhase.current !== state?.phase &&
      ['failed', 'summaryFailed'].includes(state?.phase ?? '')
    )
      setOpen(true)
    previousPhase.current = state?.phase
  }, [state?.phase])
  const busy = sending || ['waiting', 'summarizing', 'applying'].includes(state?.phase ?? '')
  const summaryFailed = state?.phase === 'summaryFailed'
  const replace = state ? state.mode === 'replace' : manager.harness !== 'claude-code'
  const cancellable = state?.phase === 'waiting'
  const label = t(
    cancellable
      ? 'manager.resetCancel'
      : busy
        ? 'manager.resetApplying'
        : state?.outdated
          ? 'manager.resetOutdated'
          : 'manager.reset',
  )
  const submit = async () => {
    setSending(true)
    setError('')
    try {
      await channel.command('managers.reset', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        ...(summaryFailed ? { boardOnly: true } : {}),
      })
      setOpen(false)
    } catch (caught) {
      setError(reasonOf(caught, t))
    } finally {
      setSending(false)
    }
  }
  const cancel = async () => {
    setSending(true)
    setError('')
    try {
      await channel.command('managers.reset.cancel', {
        deviceId: manager.deviceId,
        managerId: manager.id,
      })
    } catch (caught) {
      setError(reasonOf(caught, t))
      setOpen(true)
    } finally {
      setSending(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn ghost manager-reset"
        data-act={cancellable ? 'manager-reset-cancel' : 'manager-reset'}
        disabled={disabled || sending || (busy && !cancellable)}
        aria-label={t(cancellable ? 'manager.resetCancel' : 'manager.reset')}
        title={
          cancellable
            ? `${label} · ${t(replace ? 'manager.resetWaitingReplace' : 'manager.resetWaiting')}`
            : label
        }
        onClick={() => (cancellable ? void cancel() : setOpen(true))}
      >
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d={cancellable ? 'M5 5l10 10M15 5L5 15' : 'M16 7a6.5 6.5 0 1 0 .3 5M16 3v4h-4'} />
        </svg>
        {state?.outdated || state?.phase === 'failed' || summaryFailed ? (
          <i className="manager-reset-dot" />
        ) : null}
      </button>
      {open ? (
        <Confirm
          title={t('manager.reset')}
          note={t('manager.resetNote')}
          yes={t(summaryFailed ? 'manager.resetBoardOnly' : 'manager.reset')}
          no={t('manager.cancel')}
          tone={replace ? 'danger' : 'primary'}
          onYes={() => {
            if (!sending) void submit()
          }}
          onClose={() => setOpen(false)}
        >
          <span>{t(replace ? 'manager.resetReplace' : 'manager.resetRefresh')}</span>
          {manager.historyThreadIds?.map((threadId, index) => (
            <button
              key={threadId}
              type="button"
              className="btn ghost"
              onClick={() => {
                setOpen(false)
                requestOpenSession({ deviceId: manager.deviceId, sessionId: threadId })
              }}
            >
              {t('manager.resetHistory', { n: index + 1 })}
            </button>
          ))}
          {summaryFailed ? <span className="wait">{t('manager.resetSummaryFailed')}</span> : null}
          {error || state?.error ? <span role="alert">{error || state?.error}</span> : null}
        </Confirm>
      ) : null}
    </>
  )
}
