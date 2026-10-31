import { useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import type { useProviderSwitch } from './useProviderSwitch.ts'

export function ProviderSwitchDialog({
  state,
  running,
  able,
}: {
  state: ReturnType<typeof useProviderSwitch>
  running: boolean
  able: boolean
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const busy = state.pending?.busy ?? false
  return (
    <dialog
      ref={dialog}
      className="modal confirm"
      aria-label={t('composer.switch.title')}
      onCancel={(event) => {
        event.preventDefault()
        state.close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) state.close()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <div className="confirm-body">
        <b>{t('composer.switch.title')}</b>
        <span>{t('composer.switch.note')}</span>
        {busy ? (
          <span role="status">{t('composer.switch.working')}</span>
        ) : running ? (
          <span>{t('composer.switch.stop')}</span>
        ) : null}
        {!able ? <span>{t('composer.switch.unavailable')}</span> : null}
        {state.pending?.error ? <span role="alert">{whyNot(state.pending.error, t)}</span> : null}
        <div className="pick-ask-actions">
          <button
            type="button"
            className="btn ghost"
            // biome-ignore lint/a11y/noAutofocus: 打开时焦点落在取消，避免误确认。
            autoFocus
            disabled={busy}
            onClick={state.close}
          >
            {t('tree.dialog.cancel')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || running}
            onClick={() => void state.confirm(false)}
          >
            {t('composer.switch.direct')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || running || !able}
            aria-busy={busy}
            onClick={() => void state.confirm(true)}
          >
            {t('composer.switch.compact')}
          </button>
        </div>
      </div>
    </dialog>
  )
}
