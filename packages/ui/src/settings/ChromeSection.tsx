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
  // 不兼容按哪一边该更新给出办法；商店装的和开发者模式加载的更新方式不同
  const broken = state?.instances.find((instance) => instance.incompatible) ?? null
  const status = !state?.prepared
    ? 'chrome.unprepared'
    : !connected
      ? 'chrome.disconnected'
      : !broken
        ? 'chrome.connected'
        : broken.incompatible === 'litchOutdated'
          ? 'chrome.litchOutdated'
          : broken.source === 'store'
            ? 'chrome.extensionOutdatedStore'
            : 'chrome.extensionOutdated'
  // 开发者模式加载的扩展不会自己更新：目录里换了新版本，提示去重新加载（兼容时不挡使用）
  const reload = state?.instances.some(
    (instance) =>
      !instance.incompatible &&
      instance.source === 'unpacked' &&
      instance.version !== state.bundledVersion,
  )
  const store = state?.storeUrl ?? null
  const prepare = (
    <button
      className="btn"
      type="button"
      disabled={busy || !state}
      onClick={() => void run({ kind: 'chrome.prepare' })}
    >
      {t('chrome.prepare')}
    </button>
  )
  const stop = (
    <button
      className="btn"
      type="button"
      disabled={busy || !state?.instances.length}
      onClick={() => void run({ kind: 'chrome.stop' })}
    >
      {t('chrome.stop')}
    </button>
  )
  const folder = state?.prepared ? (
    <>
      <p className="set-para">{t('chrome.install')}</p>
      <div className="chrome-extension-path">
        <code>{state.extensionDirectory}</code>
      </div>
      <p className="set-note">
        {t('chrome.version', { version: state.bundledVersion })} · {state.extensionId}
      </p>
    </>
  ) : null
  const unpackedActions = (
    <>
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
    </>
  )
  return (
    <section className="set-block" data-chrome-settings>
      {/* 页头已经写了“Chrome”和一句说明（SettingsPage.tsx），这里不再重复 */}
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
          {/* 状态一行：连上了写哪个 Chrome、什么版本；不兼容用出错色并写该更新哪边 */}
          <p className={broken ? 'set-note err' : 'set-note'} role="status" data-chrome-state>
            {t(status)}
            {state?.instances.map((instance) => (
              <span key={instance.id}>{` · ${instance.name} ${instance.version}`}</span>
            ))}
          </p>
          {reload ? (
            <p className="set-note" data-chrome-reload>
              {t('chrome.reloadAvailable', { version: state?.bundledVersion ?? '' })}
            </p>
          ) : null}
          {store ? (
            <>
              {/* 上架后：商店安装为主，开发者模式加载收在下面作备选 */}
              <p className="set-para">{t('chrome.storeInstall')}</p>
              <div className="set-actions chrome-actions">
                {prepare}
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !state}
                  onClick={() => void run({ kind: 'chrome.store' })}
                >
                  {t('chrome.store')}
                </button>
                {stop}
              </div>
              <details className="chrome-unpacked" data-chrome-unpacked>
                <summary>{t('chrome.unpacked')}</summary>
                {folder}
                <div className="set-actions chrome-actions">{unpackedActions}</div>
              </details>
            </>
          ) : (
            <>
              {folder}
              {/* 操作排在说明和目录下面：先读怎么装，再点 */}
              <div className="set-actions chrome-actions">
                {prepare}
                {unpackedActions}
                {stop}
              </div>
            </>
          )}
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
