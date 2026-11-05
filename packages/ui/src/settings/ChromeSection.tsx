import './chrome-section.css'
import {
  type ChromeSettingsRequest,
  type ChromeSettingsState,
  type DeviceView,
  keys,
} from '@litch/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { SavedSites, type SiteSettingsBridge, TrustAll } from './BrowserSection.tsx'

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
  // 安装/开关操作期间不轮询，操作前发出的旧状态也不能覆盖操作结果。
  const revision = useRef(0)
  const mutating = useRef(false)
  const run = useCallback(
    async (request: ChromeSettingsRequest) => {
      revision.current++
      mutating.current = true
      setBusy(true)
      try {
        setState(await channel.command('chrome.settings', request))
        setError(null)
      } catch (failure) {
        setError(reasonOf(failure, t))
      } finally {
        revision.current++
        mutating.current = false
        setBusy(false)
      }
    },
    [channel, t],
  )
  useEffect(() => {
    if (shell !== 'electron') return
    let live = true
    let pending = false
    const refresh = () => {
      if (pending || mutating.current) return
      pending = true
      const before = revision.current
      void channel.command('chrome.settings', { kind: 'chrome.status' }).then(
        (next) => {
          pending = false
          if (live && before === revision.current) setState(next)
        },
        () => {
          pending = false
        },
      )
    }
    refresh()
    const timer = setInterval(refresh, 2500)
    window.addEventListener('focus', refresh)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [channel, shell])
  const sites = useMemo<SiteSettingsBridge>(() => {
    const request = (value: ChromeSettingsRequest) => channel.command('chrome.settings', value)
    return {
      policy: async () => (await request({ kind: 'chrome.status' })).sitePolicy,
      onPolicy: (receive) => {
        const timer = setInterval(() => {
          void request({ kind: 'chrome.status' }).then(
            (next) => receive(next.sitePolicy),
            () => {},
          )
        }, 2500)
        return () => clearInterval(timer)
      },
      setTrustAll: async (on) => (await request({ kind: 'chrome.trust', on })).sitePolicy,
      block: async (site) => (await request({ kind: 'chrome.block', site })).sitePolicy,
      unblock: async (host) => (await request({ kind: 'chrome.unblock', host })).sitePolicy,
      sites: async () => (await request({ kind: 'chrome.status' })).savedSites,
      forgetSite: (origin) => request({ kind: 'chrome.forget', origin }),
    }
  }, [channel])
  if (shell !== 'electron') return null
  const connected = (state?.instances.length ?? 0) > 0
  // 不兼容按哪一边该更新给出办法；商店装的和开发者模式加载的更新方式不同
  const broken = state?.instances.find((instance) => instance.incompatible) ?? null
  const status = !state
    ? 'chrome.checking'
    : !state.prepared
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
          {state?.platform ? (
            <p className="set-note">{t(`chrome.browsers.${state.platform}`)}</p>
          ) : null}
          {reload ? (
            <p className="set-note" data-chrome-reload>
              {t('chrome.reloadAvailable', { version: state?.bundledVersion ?? '' })}
            </p>
          ) : null}
          {store ? (
            <>
              <h4>{t('chrome.storeHeading')}</h4>
              <p className="set-para">{t('chrome.storeInstall')}</p>
              <div className="set-actions chrome-actions">
                <button
                  className="btn primary"
                  type="button"
                  data-chrome-store
                  disabled={busy || !state}
                  onClick={() => void run({ kind: 'chrome.store' })}
                >
                  {t(connected ? 'chrome.store' : 'chrome.storeInstallAction')}
                </button>
                {state?.prepared && (!connected || broken?.incompatible === 'extensionOutdated') ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void run({ kind: 'chrome.extensions' })}
                  >
                    {t('chrome.extensions')}
                  </button>
                ) : null}
                {stop}
              </div>
              {state?.prepared && !connected ? (
                <p className="set-note" data-chrome-waiting>
                  {t('chrome.waitingHelp')}
                </p>
              ) : null}
              <details className="chrome-unpacked" data-chrome-unpacked>
                <summary>{t('chrome.unpacked')}</summary>
                <p className="set-note">{t('chrome.manualPrepare')}</p>
                <div className="set-actions chrome-actions">{prepare}</div>
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
          <TrustAll bridge={sites} />
          <SavedSites bridge={sites} />
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
