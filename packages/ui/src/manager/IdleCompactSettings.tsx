import {
  IDLE_COMPACT_MINUTES,
  IDLE_COMPACT_PERCENT,
  idleCompactInteger,
  type ManagerIdleCompactSettings,
  type ManagerView,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

export function IdleCompactSettings({
  manager,
  saved,
  disabled,
}: {
  manager: ManagerView
  saved: ManagerIdleCompactSettings
  disabled: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [enabled, setEnabled] = useState(saved.enabled)
  const [minutes, setMinutes] = useState(String(saved.idleMinutes))
  const [percent, setPercent] = useState(String(saved.contextPercent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const idleMinutes = Number(minutes)
  const contextPercent = Number(percent)
  const minutesOk = idleCompactInteger(idleMinutes, IDLE_COMPACT_MINUTES)
  const percentOk = idleCompactInteger(contextPercent, IDLE_COMPACT_PERCENT)
  const unchanged =
    enabled === saved.enabled &&
    idleMinutes === saved.idleMinutes &&
    contextPercent === saved.contextPercent
  async function submit() {
    if (!minutesOk || !percentOk || disabled || busy || unchanged) return
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.update', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        patch: { idleCompact: { enabled, idleMinutes, contextPercent } },
      })
      setConfirmed(true)
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="mg-form"
      data-manager-idle-compact
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <fieldset className="mg-fields mng-sec" disabled={disabled || busy}>
        <h2>{t('manager.unattended')}</h2>
        <label className="form-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked)
              setConfirmed(false)
            }}
          />{' '}
          {t('manager.idleCompact.enabled')}
        </label>
        <p className="dim">{t('manager.idleCompact.hint')}</p>
        <div className="mg-form-grid">
          <label className="form-field">
            <span className="form-label">{t('manager.idleCompact.minutes')}</span>
            <input
              type="text"
              inputMode="numeric"
              className="req-input"
              value={minutes}
              aria-invalid={!minutesOk}
              onChange={(e) => {
                setMinutes(e.target.value)
                setConfirmed(false)
              }}
            />
            {!minutesOk ? (
              <small>{t('manager.idleCompact.range', IDLE_COMPACT_MINUTES)}</small>
            ) : null}
          </label>
          <label className="form-field">
            <span className="form-label">{t('manager.idleCompact.percent')}</span>
            <input
              type="text"
              inputMode="numeric"
              className="req-input"
              value={percent}
              aria-invalid={!percentOk}
              onChange={(e) => {
                setPercent(e.target.value)
                setConfirmed(false)
              }}
            />
            {!percentOk ? (
              <small>{t('manager.idleCompact.range', IDLE_COMPACT_PERCENT)}</small>
            ) : null}
          </label>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="btn" disabled={unchanged || !minutesOk || !percentOk}>
          {t('manager.save')}
        </button>
        {confirmed ? (
          <span role="status" className="dim">
            {' '}
            · {t('manager.idleCompact.saved')}
          </span>
        ) : null}
      </fieldset>
    </form>
  )
}
