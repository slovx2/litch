import './chrome-section.css'
import {
  type ChromeSettingsRequest,
  type ChromeSettingsState,
  type DeviceView,
  keys,
} from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'

export function ChromeSection() {
  const t = useT()
  const { channel, shell } = useServices()
  const ids = useKey<string[]>(keys.devices) ?? []
  const devices = useKeys<DeviceView>(ids.map(keys.device)).filter(
    (device) => device?.kind === 'ssh',
  )
  const [state, setState] = useState<ChromeSettingsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (request: ChromeSettingsRequest) => {
      setBusy(true)
      try {
        setState(await channel.command('chrome.settings', request))
        setError(null)
      } catch (failure) {
        setError(reasonOf(failure, t))
      } finally {
        setBusy(false)
      }
    },
    [channel, t],
  )
  useEffect(() => {
    if (shell !== 'electron') return
    let live = true
    const refresh = () => {
      void channel.command('chrome.settings', { kind: 'chrome.status' }).then(
        (next) => {
          if (live) setState(next)
        },
        () => {},
      )
    }
    refresh()
    const timer = setInterval(refresh, 2500)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [channel, shell])
  if (shell !== 'electron') return null
  return (
    <section className="set-block" data-chrome-settings>
      <h3>{t('chrome.title')}</h3>
      <p className="set-para">{t('chrome.note')}</p>
      {state && !state.supported ? (
        <p className="set-note">{t('chrome.unsupported')}</p>
      ) : (
        <>
          <div className="set-rows">
            <div className="set-row">
              <div className="set-switch-text">
                <label htmlFor="chrome-enable">{t('chrome.enable')}</label>
              </div>
              <button
                id="chrome-enable"
                className="switch"
                type="button"
                role="switch"
                aria-checked={state?.enabled ?? false}
                disabled={busy || !state}
                onClick={() => void run({ kind: 'chrome.enable', enabled: !state?.enabled })}
              >
                <i />
              </button>
            </div>
          </div>
          <p className="set-note">
            {t(
              !state?.prepared
                ? 'chrome.unprepared'
                : state.instances.length === 0
                  ? 'chrome.disconnected'
                  : state.instances.some((instance) => !instance.compatible)
                    ? 'chrome.mismatch'
                    : 'chrome.connected',
            )}
          </p>
          <div className="set-actions">
            <button
              className="btn"
              type="button"
              disabled={busy || !state}
              onClick={() => void run({ kind: 'chrome.prepare' })}
            >
              {t('chrome.prepare')}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || !state?.prepared}
              onClick={() => void run({ kind: 'chrome.extensions' })}
            >
              {t('chrome.extensions')}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || !state?.prepared}
              onClick={() => void run({ kind: 'chrome.directory' })}
            >
              {t('chrome.directory')}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || !state?.instances.length}
              onClick={() => void run({ kind: 'chrome.stop' })}
            >
              {t('chrome.stop')}
            </button>
          </div>
          {state?.prepared ? (
            <>
              <p className="set-para">{t('chrome.install')}</p>
              <div className="chrome-extension-path">
                <code>{state.extensionDirectory}</code>
              </div>
              <p className="set-note">
                {t('chrome.version', { version: state.expectedVersion })} · {state.extensionId}
              </p>
            </>
          ) : null}
          {state?.instances.map((instance) => (
            <p className="set-note" key={instance.id}>
              {instance.name} · {instance.version} · {instance.id.slice(0, 8)}
            </p>
          ))}
          {devices.length ? (
            <>
              <h4>{t('chrome.remote')}</h4>
              <p className="set-note">{t('chrome.remoteNote')}</p>
              <div className="set-rows">
                {devices.map((device) =>
                  device ? (
                    <div className="set-row" key={device.id}>
                      <div className="set-switch-text">
                        <span>{t.text(device.name)}</span>
                      </div>
                      <button
                        className="switch"
                        type="button"
                        role="switch"
                        aria-label={t.text(device.name)}
                        aria-checked={state?.allowedDevices.includes(device.id) ?? false}
                        disabled={busy || !state?.enabled}
                        onClick={() =>
                          void run({
                            kind: 'chrome.device',
                            deviceId: device.id,
                            enabled: !state?.allowedDevices.includes(device.id),
                          })
                        }
                      >
                        <i />
                      </button>
                    </div>
                  ) : null,
                )}
              </div>
            </>
          ) : null}
        </>
      )}
      {error || state?.lastError ? (
        <p className="set-note err" role="alert">
          {error ?? state?.lastError}
        </p>
      ) : null}
    </section>
  )
}
