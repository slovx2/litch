import { useEffect, useRef, useState } from 'react'
import type {
  ManagerResetOperation,
  ManagerResetPreview,
  ManagerResetTarget,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { ResetTargetPreview, ResetTargetSettings } from './ResetTargetSettings.tsx'
import { resetHarnessName, resetSettingsText, resetTargetChanged } from './reset-target.ts'
import './reset-target.css'

type Plan = Pick<ManagerResetOperation, 'requestId' | 'target' | 'expectedSettingsHash'> & {
  expectedThreadId: string
}

export function ResetTargetManager({
  manager,
  disabled,
}: {
  manager: ManagerView
  disabled: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const state = manager.reset
  const operation = state?.operation
  const summaryFailed = state?.phase === 'summaryFailed'
  const busy = ['waiting', 'summarizing', 'applying'].includes(state?.phase ?? '')
  const cancellable = state?.phase === 'waiting'
  const handoverFailed = operation?.committed && operation.handover === 'failed'
  const locked = summaryFailed || busy
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState<ManagerResetTarget>()
  const [preview, setPreview] = useState<ManagerResetPreview>()
  const [loading, setLoading] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const plan = useRef<Plan | null>(null)
  const previousPhase = useRef(state?.phase)
  const requestRevision = useRef(0)
  useEffect(() => {
    if (
      previousPhase.current !== state?.phase &&
      (summaryFailed || state?.phase === 'failed' || handoverFailed)
    )
      setOpen(true)
    previousPhase.current = state?.phase
  }, [state?.phase, summaryFailed, handoverFailed])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
  }, [open])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 经理换绑和用户重试时必须重新预检。
  useEffect(() => {
    if (!open || locked) return
    let active = true
    const generation = ++requestRevision.current
    setLoading(true)
    setVerified(false)
    setError('')
    void channel
      .command('managers.reset.preview', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        ...(draft ? { target: draft } : {}),
      })
      .then((next) => {
        if (active && requestRevision.current === generation) {
          if (
            plan.current &&
            (plan.current.expectedThreadId !== next.expectedThreadId ||
              plan.current.expectedSettingsHash !== next.expectedSettingsHash)
          )
            plan.current = null
          setPreview(next)
          setVerified(true)
        }
      })
      .catch((caught) => {
        if (active && requestRevision.current === generation) setError(reasonOf(caught, t))
      })
      .finally(() => {
        if (active && requestRevision.current === generation) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [channel, open, locked, manager.deviceId, manager.id, manager.threadId, draft, revision, t])
  const show = () => {
    setDraft(undefined)
    setPreview(undefined)
    setVerified(false)
    setError('')
    plan.current = null
    setOpen(true)
  }
  const change = (target: ManagerResetTarget) => {
    // 选择发生时立即作废预检，不能在 effect 执行前提交旧目标。
    ++requestRevision.current
    setLoading(true)
    setVerified(false)
    setDraft(target)
    plan.current = null
  }
  const cancel = async () => {
    setSending(true)
    setError('')
    try {
      await channel.command('managers.reset.cancel', {
        deviceId: manager.deviceId,
        managerId: manager.id,
      })
      setOpen(false)
    } catch (caught) {
      setError(reasonOf(caught, t))
      setOpen(true)
    } finally {
      setSending(false)
    }
  }
  const submit = async () => {
    if (sending || disabled || busy) return
    if (summaryFailed) {
      if (operation ? operation.source.permission === null : preview?.source.permission == null)
        return
      // 断线重进也从设备操作记录恢复同一请求，不重新解释默认设置。
      if (operation)
        plan.current = {
          requestId: operation.requestId,
          target: operation.target,
          expectedThreadId: operation.source.threadId,
          expectedSettingsHash: operation.expectedSettingsHash,
        }
      if (!plan.current) return
    } else {
      if (!verified || loading || !preview?.canSubmit || preview.source.permission === null) return
      plan.current ??= {
        requestId: crypto.randomUUID(),
        target: preview.target,
        expectedThreadId: preview.expectedThreadId,
        expectedSettingsHash: preview.expectedSettingsHash,
      }
    }
    setSending(true)
    setError('')
    try {
      const result = await channel.command('managers.reset', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        ...plan.current,
        ...(summaryFailed ? { boardOnly: true } : {}),
      })
      setOpen(
        result.manager.reset?.phase === 'summaryFailed' ||
          result.manager.reset?.phase === 'failed' ||
          result.manager.reset?.operation?.handover === 'failed',
      )
    } catch (caught) {
      setError(reasonOf(caught, t))
    } finally {
      setSending(false)
    }
  }
  const source = locked ? operation?.source : preview?.source
  const target = locked ? operation?.target : preview?.target
  const changed = source && target ? resetTargetChanged(source, target, manager.dispatch) : false
  const replace =
    (source && target && source.harness !== target.harness) ||
    (locked ? state?.mode === 'replace' : preview?.mode === 'replace')
  const title = t(changed ? 'manager.resetSwitchTitle' : 'manager.reset')
  const waitingText = operation
    ? t('manager.resetTargetWaiting', {
        source: resetHarnessName(operation.source.harness, t),
        target: resetHarnessName(operation.target.harness, t),
      })
    : t('manager.resetWaitingReplace')
  const valid = summaryFailed
    ? Boolean((operation || plan.current) && source?.permission != null)
    : Boolean(preview?.canSubmit && preview.source.permission !== null && !loading && verified)
  return (
    <>
      {busy && operation ? (
        <span
          className="reset-target-status"
          role="status"
          title={`${resetSettingsText(operation.source, t)} → ${resetSettingsText(operation.target, t)}`}
        >
          {waitingText}
        </span>
      ) : null}
      {handoverFailed ? (
        <span className="reset-target-status" role="alert">
          {t('manager.resetHandoverFailed')}
        </span>
      ) : null}
      <button
        type="button"
        className="btn ghost manager-reset"
        data-act={cancellable ? 'manager-reset-cancel' : 'manager-reset'}
        disabled={disabled || sending || (busy && !cancellable)}
        aria-label={t(cancellable ? 'manager.resetCancel' : 'manager.reset')}
        title={
          cancellable
            ? `${t('manager.resetCancel')} · ${waitingText}`
            : t(
                busy
                  ? 'manager.resetApplying'
                  : state?.outdated
                    ? 'manager.resetOutdated'
                    : 'manager.reset',
              )
        }
        onClick={() => (cancellable ? void cancel() : show())}
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
        {state?.outdated || state?.phase === 'failed' || summaryFailed || handoverFailed ? (
          <i className="manager-reset-dot" />
        ) : null}
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="modal reset-target-dialog"
          aria-label={title}
          onClose={() => setOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation()
          }}
        >
          <div className="reset-target-heading">
            <b>{title}</b>
          </div>
          <div className="confirm-body">
            <span>{t(replace ? 'manager.resetTargetNote' : 'manager.resetNote')}</span>
            {locked && operation ? (
              <div className="reset-target-preview">
                <b>{t('manager.resetSource')}</b>
                <span>{resetSettingsText(operation.source, t)}</span>
                <b>→ {t('manager.resetTarget')}</b>
                <span>{resetSettingsText(operation.target, t)}</span>
                <span>{t('manager.resetTargetLocked')}</span>
                {operation.source.permission === null ? (
                  <span role="alert">{t('manager.resetPermissionUnknown')}</span>
                ) : null}
              </div>
            ) : preview ? (
              <>
                <ResetTargetSettings
                  preview={preview}
                  dispatch={manager.dispatch}
                  onChange={change}
                  disabled={sending || disabled || loading}
                />
                <ResetTargetPreview preview={preview} deviceId={manager.deviceId} />
              </>
            ) : null}
            {loading && !locked ? (
              <span role="status">{t('manager.resetPreviewLoading')}</span>
            ) : null}
            {preview || locked ? (
              <span>
                {t(
                  summaryFailed
                    ? 'manager.resetBoardOnlyReplace'
                    : replace
                      ? 'manager.resetTargetReplace'
                      : 'manager.resetRefresh',
                )}
              </span>
            ) : null}
            {summaryFailed && target ? (
              <span className="wait">
                {t('manager.resetTargetSummaryFailed', {
                  target: resetHarnessName(target.harness, t),
                })}
              </span>
            ) : null}
            {handoverFailed ? <span role="alert">{t('manager.resetHandoverFailed')}</span> : null}
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
            {error || state?.error ? <span role="alert">{error || state?.error}</span> : null}
            {!locked && error ? (
              <button type="button" className="btn ghost" onClick={() => setRevision((n) => n + 1)}>
                {t('manager.resetPreviewRetry')}
              </button>
            ) : null}
          </div>
          <div className="pick-ask-actions reset-target-actions">
            {/* biome-ignore lint/a11y/noAutofocus: 确认框初始焦点在取消，避免误提交。 */}
            <button type="button" className="btn ghost" autoFocus onClick={() => setOpen(false)}>
              {t('manager.cancel')}
            </button>
            {cancellable ? (
              <button
                type="button"
                className="btn primary"
                disabled={sending || disabled}
                onClick={() => void cancel()}
              >
                {t('manager.resetCancel')}
              </button>
            ) : (
              <button
                type="button"
                className={`btn ${replace ? 'danger' : 'primary'} confirm-yes`}
                disabled={sending || disabled || busy || !valid}
                onClick={() => void submit()}
              >
                {t(
                  summaryFailed
                    ? 'manager.resetBoardOnly'
                    : changed
                      ? 'manager.resetSwitch'
                      : 'manager.reset',
                )}
              </button>
            )}
          </div>
        </dialog>
      ) : null}
    </>
  )
}
