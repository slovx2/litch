// 浏览器面板上的“代理请你登录”：代理调了 request_sign_in，把一个标签交给人。画在 Litch 的界面里、网页上面，
// 网页和代理都看不到。醒目的是外壳取到的真实来源（随导航更新），代理说的站点名和原因只作附注。
// 人在网页里自己登录（能用已保存的密码），点“完成，交还”或“取消”之后代理才接着做；这段时间代理碰不了这个标签。
// 交还之前外壳会清空密码框，代理只知道人点了哪个。代理不等了（回合打断、结束）时卡片变成“代理已收回”，
// 提醒别再在这里输入，点“知道了”才没。
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSignInAnswer,
  BrowserSignInRequest,
} from './bridge.ts'
import { signInsFor } from './sign-in-logic.ts'
import { chooseBrowserTab } from './store.ts'
import './sign-in.css'

export function SignInCard({
  bridge,
  owner,
  currentTabId,
}: {
  bridge: BrowserBridge
  owner: BrowserOwner
  currentTabId: string | null
}) {
  const t = useT()
  const signIn = bridge.signIn
  const [all, setAll] = useState<BrowserSignInRequest[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    signIn.list().then(
      (list) => {
        if (live) setAll(list)
      },
      () => {},
    )
    const off = signIn.onChanged((list) => setAll(list))
    return () => {
      live = false
      off()
    }
  }, [signIn])

  const mine = useMemo(() => signInsFor(all, owner, currentTabId), [all, owner, currentTabId])
  const request = mine[0]
  if (!request) return null

  const answer = (choice: BrowserSignInAnswer) => {
    setBusy(true)
    void signIn
      .answer(request.id, choice)
      .catch(() => false)
      .finally(() => setBusy(false))
  }
  const elsewhere = request.tabId !== currentTabId
  const show = elsewhere ? (
    <button
      type="button"
      className="btn ghost"
      data-act="sign-in-show"
      onClick={() => chooseBrowserTab(owner, request.tabId)}
    >
      {t('browser.signIn.show')}
    </button>
  ) : null
  // 醒目的是外壳取到的真实来源；代理说的站点名和原因只作附注
  const origin = (
    <span className="bw-signin-origin mono" data-sign-in-origin>
      {request.origin || t('browser.signIn.noOrigin')}
    </span>
  )
  const claim = (
    <span className="bw-signin-claim">
      {t('browser.signIn.claim', {
        site: request.site,
        reason: request.reason || '—',
      })}
    </span>
  )
  if (request.state === 'withdrawn') {
    return (
      <div
        className="bw-signin withdrawn"
        role="alert"
        data-sign-in={request.id}
        data-state="withdrawn"
      >
        <div className="bw-signin-text">
          <strong>{t('browser.signIn.withdrawn')}</strong>
          {origin}
          <span className="bw-signin-note">{t('browser.signIn.withdrawnNote')}</span>
        </div>
        <span className="bw-signin-acts">
          {show}
          <button
            type="button"
            className="btn"
            data-act="sign-in-dismiss"
            disabled={busy}
            onClick={() => answer('dismiss')}
          >
            {t('browser.signIn.dismiss')}
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="bw-signin" role="alert" data-sign-in={request.id} data-state="waiting">
      <div className="bw-signin-text">
        <strong>{t('browser.signIn.title')}</strong>
        {origin}
        {claim}
        <span className="bw-signin-note">{t('browser.signIn.note')}</span>
      </div>
      <span className="bw-signin-acts">
        {show}
        <button
          type="button"
          className="btn"
          data-act="sign-in-done"
          disabled={busy}
          onClick={() => answer('done')}
        >
          {t('browser.signIn.done')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="sign-in-cancel"
          disabled={busy}
          onClick={() => answer('cancel')}
        >
          {t('browser.signIn.cancel')}
        </button>
      </span>
    </div>
  )
}
