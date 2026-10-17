// 设置页“内置浏览器”那一组：对话里的链接用不用内置浏览器打开（记在界面本地，side/browser/links.ts），
// 一直允许的网站（列出、删一个、全删），清除浏览数据（先确认）。
// 后两样经外壳的 window.litchBrowser（apps/desktop/src/browser/install.mts 的 settings）；普通浏览器里没有外壳，只写一句说明。
// 浏览器是这台电脑上的，所有会话、所有设备共用一份，所以放在应用级的设置里，不按设备。
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { currentPlatform } from '../app/platform.ts'
import { showToast } from '../app/toasts.tsx'
import { type BrowserBridge, type BrowserSavedSite, browserBridge } from '../side/browser/bridge.ts'
import { setLinksInBrowser, useLinksInBrowser } from '../side/browser/links.ts'
import { dayOf, listPhase, siteLabel, sortSites } from './tools-logic.ts'

export function BrowserSection() {
  const t = useT()
  const bridge = browserBridge()
  if (!bridge) {
    return (
      <section className="set-block" data-browser="none">
        <p className="set-para">{t('settings.browser.desktopOnly')}</p>
      </section>
    )
  }
  return (
    <>
      <LinkSwitch />
      <SavedSites bridge={bridge} />
      <BrowsingData bridge={bridge} />
    </>
  )
}

/** 对话里的链接用不用内置浏览器打开。默认开 */
function LinkSwitch() {
  const t = useT()
  const on = useLinksInBrowser()
  const key = currentPlatform() === 'mac' ? 'Cmd' : 'Ctrl'
  return (
    <section className="set-block" data-links={on ? 'browser' : 'external'}>
      <h3>{t('settings.browser.links')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-switch-text">
            <label htmlFor="set-links-in-browser">{t('settings.browser.links.title')}</label>
            <span className="set-note">{t('settings.browser.links.note', { key })}</span>
          </div>
          <button
            id="set-links-in-browser"
            type="button"
            role="switch"
            className="switch"
            data-act="links-in-browser"
            aria-checked={on}
            onClick={() => setLinksInBrowser(!on)}
          >
            <i />
          </button>
        </div>
      </div>
    </section>
  )
}

/** 一直允许的网站。这一组打开时取一次，删了之后照删完的样子再取 */
function SavedSites({ bridge }: { bridge: BrowserBridge }) {
  const t = useT()
  /** null：在取 */
  const [sites, setSites] = useState<BrowserSavedSite[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    () =>
      bridge.sites().then(
        (list) => {
          setSites(sortSites(list))
          setFailure(null)
        },
        (error: unknown) => setFailure(reasonOf(error, t)),
      ),
    [bridge, t],
  )
  useEffect(() => {
    void load()
  }, [load])

  const forget = (origin: string | null) => {
    setBusy(true)
    bridge
      .forgetSite(origin)
      .then(load, (error: unknown) => setFailure(reasonOf(error, t)))
      .finally(() => setBusy(false))
  }

  const phase = listPhase(sites, failure !== null && sites === null)
  return (
    <section className="set-block" data-sites={phase}>
      <h3>
        {t('settings.browser.sites')}
        <span>{t('settings.browser.sites.note')}</span>
      </h3>
      {phase === 'loading' ? (
        <p className="set-para">{t('settings.about.loading')}</p>
      ) : phase === 'failed' ? (
        <p className="set-para err" role="alert">
          {t('settings.browser.failed', { reason: failure ?? '' })}
        </p>
      ) : phase === 'empty' ? (
        <p className="set-para">{t('settings.browser.sites.empty')}</p>
      ) : (
        <>
          <div className="set-rows">
            {(sites ?? []).map((site) => (
              <div key={site.origin} className="set-row tool-row" data-site={site.origin}>
                <span className="tool-name" title={site.origin}>
                  {siteLabel(site.origin)}
                </span>
                <span className="tool-when">
                  {t('settings.browser.sites.at', { day: dayOf(site.at) })}
                </span>
                <button
                  type="button"
                  className="mini"
                  data-act="forget-site"
                  disabled={busy}
                  onClick={() => forget(site.origin)}
                >
                  {t('settings.browser.forget')}
                </button>
              </div>
            ))}
          </div>
          <div className="set-actions">
            {failure ? (
              <span className="set-note err" role="alert">
                {t('settings.browser.failed', { reason: failure })}
              </span>
            ) : null}
            <button
              type="button"
              className="btn ghost"
              data-act="forget-all"
              disabled={busy}
              onClick={() => forget(null)}
            >
              {t('settings.browser.forgetAll')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/** 清除浏览数据：找不回来，先确认 */
function BrowsingData({ bridge }: { bridge: BrowserBridge }) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  const clear = () => {
    setAsking(false)
    setBusy(true)
    bridge
      .clearData()
      .then(
        (done) =>
          showToast(
            done
              ? { id: 'browser-clear', lifeMs: 3000, text: (tr) => tr('settings.browser.cleared') }
              : {
                  id: 'browser-clear',
                  tone: 'err',
                  lifeMs: 6000,
                  text: (tr) => tr('settings.browser.clearFailed'),
                },
          ),
        (error: unknown) =>
          showToast({
            id: 'browser-clear',
            tone: 'err',
            lifeMs: 6000,
            text: (tr) => tr('settings.browser.failed', { reason: reasonOf(error, tr) }),
          }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <section className="set-block">
      <h3>{t('settings.browser.data')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <span className="set-note">{t('settings.browser.data.note')}</span>
          <button
            type="button"
            className="btn"
            data-act="clear-data"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            {t('settings.browser.clear')}
          </button>
        </div>
      </div>
      {asking ? (
        <Confirm
          title={t('settings.browser.clear.title')}
          note={t('settings.browser.clear.note')}
          yes={t('settings.browser.clear.yes')}
          no={t('permission.confirm.no')}
          onYes={clear}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  )
}
