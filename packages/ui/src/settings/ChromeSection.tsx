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
  const connected = (state?.instances.length ?? 0) > 0
  const mismatch = state?.instances.some((instance) => !instance.compatible) ?? false
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
          {/* 状态一行：连上了写哪个 Chrome、什么版本；版本不对用出错色 */}
          <p className={mismatch ? 'set-note err' : 'set-note'} role="status" data-chrome-state>
            {t(
              !state?.prepared
                ? 'chrome.unprepared'
                : !connected
                  ? 'chrome.disconnected'
                  : mismatch
                    ? 'chrome.mismatch'
                    : 'chrome.connected',
            )}
            {state?.instances.map((instance) => (
              <span key={instance.id}>{` · ${instance.name} ${instance.version}`}</span>
            ))}
          </p>
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
          {/* 操作排在说明和目录下面：先读怎么装，再点 */}
          <div className="set-actions chrome-actions">
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
