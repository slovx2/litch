// 设置页“内置浏览器”那一组：对话里的链接用不用内置浏览器打开（记在界面本地，side/browser/links.ts），
// 信任所有网站的开关和它的黑名单，一直允许的网站（列出、删一个、全删），清除浏览数据（先确认）。
// 后三样经外壳的 window.litchBrowser（apps/desktop/src/browser/install.mts 的 settings）；普通浏览器里没有外壳，只写一句说明。
// 浏览器是这台电脑上的，所有会话、所有设备共用一份，所以放在应用级的设置里，不按设备。
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { currentPlatform } from '../app/platform.ts'
import { showToast } from '../app/toasts.tsx'
import {
  type BrowserBridge,
  type BrowserSavedSite,
  type BrowserSitePolicy,
  browserBridge,
} from '../side/browser/bridge.ts'
import { setLinksInBrowser, useLinksInBrowser } from '../side/browser/links.ts'
import { BrowserImportRow } from './BrowserImportEntry.tsx'
import { ChromeSection } from './ChromeSection.tsx'
import { SavedPasswords } from './SavedPasswords.tsx'
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
      <ChromeSection />
      <LinkSwitch />
      <BrowserImportRow bridge={bridge} />
      <TrustAll bridge={bridge} />
      <SavedSites bridge={bridge} />
      <SavedPasswords bridge={bridge} />
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

/**
 * 信任所有网站：开着时不再逐个网站问，只有黑名单里的不许开。黑名单只在开着时显示（关着时它不起作用）。
 * 审批卡片上、litch config 也能改，那边改了外壳会推过来
 */
function TrustAll({ bridge }: { bridge: BrowserBridge }) {
  const t = useT()
  /** null：在取 */
  const [policy, setPolicy] = useState<BrowserSitePolicy | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [bad, setBad] = useState(false)

  useEffect(() => {
    let live = true
    bridge.policy().then(
      (next) => {
        if (live && next) setPolicy(next)
      },
      (error: unknown) => {
        if (live) setFailure(reasonOf(error, t))
      },
    )
    const off = bridge.onPolicy((next) => setPolicy(next))
    return () => {
      live = false
      off()
    }
  }, [bridge, t])

  /** 做一件改动；回 null 的（认不出的网站）交给 onNull */
  const change = (run: () => Promise<BrowserSitePolicy | null>, onNull?: () => void) => {
    setBusy(true)
    setFailure(null)
    run()
      .then(
        (next) => {
          if (next) setPolicy(next)
          else onNull?.()
          return next
        },
        (error: unknown) => {
          setFailure(reasonOf(error, t))
          return null
        },
      )
      .finally(() => setBusy(false))
  }

  const add = () => {
    const site = draft.trim()
    if (!site) return
    change(
      () =>
        bridge.block(site).then((next) => {
          if (next) setDraft('')
          return next
        }),
      () => setBad(true),
    )
  }

  const on = policy?.trustAll ?? false
  return (
    <section className="set-block" data-trust-all={policy ? (on ? 'on' : 'off') : 'loading'}>
      <h3>{t('settings.browser.trust')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-switch-text">
            <label htmlFor="set-trust-all-sites">{t('settings.browser.trust.title')}</label>
            <span className="set-note">{t('settings.browser.trust.note')}</span>
          </div>
          <button
            id="set-trust-all-sites"
            type="button"
            role="switch"
            className="switch"
            data-act="trust-all-sites"
            aria-checked={on}
            disabled={!policy || busy}
            onClick={() => change(() => bridge.setTrustAll(!on))}
          >
            <i />
          </button>
        </div>
      </div>
      {failure ? (
        <p className="set-para err" role="alert">
          {t('settings.browser.failed', { reason: failure })}
        </p>
      ) : null}
      {on && policy ? (
        <div data-blocked={policy.blocked.length}>
          <h4 className="set-sub">
            {t('settings.browser.blocked')}
            <span>{t('settings.browser.blocked.note')}</span>
          </h4>
          <div className="set-rows">
            <form
              className="set-row set-block-add"
              onSubmit={(event) => {
                event.preventDefault()
                add()
              }}
            >
              <input
                className="req-input mono"
                data-field="blocked-site"
                value={draft}
                placeholder={t('settings.browser.blocked.placeholder')}
                aria-label={t('settings.browser.blocked')}
                aria-invalid={bad}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setBad(false)
                }}
              />
              <button
                type="submit"
                className="btn"
                data-act="block-site"
                disabled={busy || draft.trim() === ''}
              >
                {t('settings.browser.blocked.add')}
              </button>
              {bad ? (
                <span className="set-note err" role="alert">
                  {t('settings.browser.blocked.bad')}
                </span>
              ) : null}
            </form>
            {policy.blocked.length === 0 ? (
              <div className="set-row">
                <span className="set-para">{t('settings.browser.blocked.empty')}</span>
              </div>
            ) : (
              policy.blocked.map((host) => (
                <div key={host} className="set-row tool-row" data-blocked-site={host}>
                  <span className="tool-name">{host}</span>
                  <button
                    type="button"
                    className="mini"
                    data-act="unblock-site"
                    disabled={busy}
                    onClick={() => change(() => bridge.unblock(host))}
                  >
                    {t('settings.browser.forget')}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
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
      <h3>{t('settings.browser.sites')}</h3>
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
