// 设置页“内置浏览器”一组里的“已保存的密码”：按站点和用户名列、搜索、删一条、全删（先确认）。
// 经外壳的 window.litchBrowser.passwords（apps/desktop/src/browser/passwords/install.mts）；
// 外壳给的列表只有站点、用户名、来源、时间，这里看不到也复制不了密码。导入了、别处删了，外壳会推“变了”，再取一次。
// 标题下面是“代填前要 Touch ID”的开关（只有 macOS 有，经外壳的 litchBrowser.signIn）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { showToast } from '../app/toasts.tsx'
import type {
  BrowserBridge,
  BrowserNeverSite,
  BrowserPasswordsBridge,
  BrowserSavedPassword,
  BrowserSignInBridge,
  BrowserTouchId,
} from '../side/browser/bridge.ts'
import {
  filterPasswords,
  SAVED_HERE,
  sortNever,
  sortPasswords,
  sourceLabel,
} from './passwords-logic.ts'
import { dayOf, listPhase, siteLabel } from './tools-logic.ts'

export function SavedPasswords({ bridge }: { bridge: BrowserBridge }) {
  const t = useT()
  const passwords = bridge.passwords
  /** null：在取 */
  const [list, setList] = useState<BrowserSavedPassword[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState(false)

  const load = useCallback(
    () =>
      passwords.list().then(
        (next) => {
          setList(sortPasswords(next))
          setFailure(null)
        },
        (error: unknown) => setFailure(reasonOf(error, t)),
      ),
    [passwords, t],
  )
  useEffect(() => {
    void load()
    return passwords.onChanged(() => void load())
  }, [passwords, load])

  const shown = useMemo(() => filterPasswords(list ?? [], query), [list, query])

  const remove = (id: string) => {
    setBusy(true)
    passwords
      .remove(id)
      .then(load, (error: unknown) => setFailure(reasonOf(error, t)))
      .finally(() => setBusy(false))
  }

  const removeAll = () => {
    setAsking(false)
    setBusy(true)
    passwords
      .removeAll()
      .then(
        (count) => {
          showToast({
            id: 'browser-passwords',
            lifeMs: 3000,
            text: (tr) => tr('settings.browser.passwords.removed', { count }),
          })
          return load()
        },
        (error: unknown) => setFailure(reasonOf(error, t)),
      )
      .finally(() => setBusy(false))
  }

  const phase = listPhase(list, failure !== null && list === null)
  return (
    <section className="set-block" data-passwords={phase}>
      <h3>
        {t('settings.browser.passwords')}
        <span>{t('settings.browser.passwords.note')}</span>
      </h3>
      <TouchIdSwitch signIn={bridge.signIn} />
      {phase === 'loading' ? (
        <p className="set-para">{t('settings.about.loading')}</p>
      ) : phase === 'failed' ? (
        <p className="set-para err" role="alert">
          {t('settings.browser.failed', { reason: failure ?? '' })}
        </p>
      ) : phase === 'empty' ? (
        <p className="set-para">{t('settings.browser.passwords.empty')}</p>
      ) : (
        <>
          <div className="set-rows">
            <div className="set-row">
              <input
                className="req-input"
                type="search"
                data-field="password-search"
                value={query}
                placeholder={t('settings.browser.passwords.search')}
                aria-label={t('settings.browser.passwords.search')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="set-note">
                {t('settings.browser.passwords.count', { count: list?.length ?? 0 })}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="set-row">
                <span className="set-para">{t('settings.browser.passwords.none')}</span>
              </div>
            ) : (
              shown.map((one) => (
                <div key={one.id} className="set-row tool-row" data-password={one.id}>
                  <span className="tool-name" title={one.origin}>
                    {siteLabel(one.origin)}
                  </span>
                  <span className="tool-name mono" data-username>
                    {one.username === '' ? t('settings.browser.passwords.noUser') : one.username}
                  </span>
                  <span className="tool-when">
                    {t('settings.browser.passwords.from', {
                      source:
                        one.source === SAVED_HERE
                          ? t('settings.browser.passwords.saved')
                          : sourceLabel(one.source),
                      day: dayOf(one.createdAt),
                    })}
                  </span>
                  <button
                    type="button"
                    className="mini"
                    data-act="forget-password"
                    disabled={busy}
                    onClick={() => remove(one.id)}
                  >
                    {t('settings.browser.forget')}
                  </button>
                </div>
              ))
            )}
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
              data-act="forget-all-passwords"
              disabled={busy}
              onClick={() => setAsking(true)}
            >
              {t('settings.browser.passwords.removeAll')}
            </button>
          </div>
        </>
      )}
      <NeverSites passwords={passwords} />
      {asking ? (
        <Confirm
          title={t('settings.browser.passwords.removeAll.title')}
          note={t('settings.browser.passwords.removeAll.note', { count: list?.length ?? 0 })}
          yes={t('settings.browser.passwords.removeAll.yes')}
          no={t('permission.confirm.no')}
          onYes={removeAll}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  )
}

/**
 * 代填前要不要过 Touch ID（默认关）。外壳说这台电脑用不了（不是 macOS、没有指纹）时不显示。
 * 主进程在 Litch 用已存账号代填之前弹系统的指纹框
 */
function TouchIdSwitch({ signIn }: { signIn: BrowserSignInBridge }) {
  const t = useT()
  /** null：在取 */
  const [state, setState] = useState<BrowserTouchId | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    signIn.touchId().then(
      (next) => {
        if (live) setState(next)
      },
      (error: unknown) => {
        if (live) setFailure(reasonOf(error, t))
      },
    )
    return () => {
      live = false
    }
  }, [signIn, t])
  if (!state?.available) return null

  const flip = () => {
    setBusy(true)
    setFailure(null)
    signIn
      .setTouchId(!state.on)
      .then(setState, (error: unknown) => setFailure(reasonOf(error, t)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="set-rows" data-touch-id={state.on ? 'on' : 'off'}>
      <div className="set-row">
        <div className="set-switch-text">
          <label htmlFor="set-touch-id">{t('settings.browser.touchId.title')}</label>
          <span className="set-note">{t('settings.browser.touchId.note')}</span>
          {failure ? (
            <span className="set-note err" role="alert">
              {t('settings.browser.failed', { reason: failure })}
            </span>
          ) : null}
        </div>
        <button
          id="set-touch-id"
          type="button"
          role="switch"
          className="switch"
          data-act="touch-id"
          aria-checked={state.on}
          disabled={busy}
          onClick={flip}
        >
          <i />
        </button>
      </div>
    </div>
  )
}

/** 从不保存密码的网站：保存提示上点了“这个网站永不”的。删一项之后在那个网站登录又会问 */
function NeverSites({ passwords }: { passwords: BrowserPasswordsBridge }) {
  const t = useT()
  /** null：在取 */
  const [sites, setSites] = useState<BrowserNeverSite[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(
    () =>
      passwords.never().then(
        (next) => {
          setSites(sortNever(next))
          setFailure(null)
        },
        (error: unknown) => setFailure(reasonOf(error, t)),
      ),
    [passwords, t],
  )
  useEffect(() => {
    void load()
    return passwords.onChanged(() => void load())
  }, [passwords, load])

  const allow = (origin: string) => {
    setBusy(true)
    passwords
      .allowSite(origin)
      .then(load, (error: unknown) => setFailure(reasonOf(error, t)))
      .finally(() => setBusy(false))
  }

  const phase = listPhase(sites, failure !== null && sites === null)
  return (
    <div data-never={phase}>
      <h4 className="set-sub">{t('settings.browser.never')}</h4>
      {phase === 'loading' ? null : phase === 'failed' ? (
        <p className="set-para err" role="alert">
          {t('settings.browser.failed', { reason: failure ?? '' })}
        </p>
      ) : phase === 'empty' ? (
        <p className="set-para">{t('settings.browser.never.empty')}</p>
      ) : (
        <div className="set-rows">
          {(sites ?? []).map((site) => (
            <div key={site.origin} className="set-row tool-row" data-never-site={site.origin}>
              <span className="tool-name" title={site.origin}>
                {siteLabel(site.origin)}
              </span>
              <span className="tool-when">
                {t('settings.browser.never.at', { day: dayOf(site.at) })}
              </span>
              <button
                type="button"
                className="mini"
                data-act="allow-password-site"
                disabled={busy}
                onClick={() => allow(site.origin)}
              >
                {t('settings.browser.forget')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
