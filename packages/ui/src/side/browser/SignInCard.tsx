// 浏览器面板上的“代理请你登录”：代理调了 request_sign_in，把一个标签交给人。画在 Litch 的界面里、网页上面，
// 网页和代理都看不到。人在网页里自己登录（能用已保存的密码），点“完成，交还”或“取消”之后代理才接着做；
// 这段时间代理碰不了这个标签。交还之前外壳会清空密码框，代理只知道人点了哪个。
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
  return (
    <div className="bw-signin" role="alert" data-sign-in={request.id}>
      <div className="bw-signin-text">
        <strong>{t('browser.signIn.title', { site: request.site })}</strong>
        {request.reason ? <span className="bw-signin-reason">{request.reason}</span> : null}
        <span className="bw-signin-note">{t('browser.signIn.note')}</span>
      </div>
      <span className="bw-signin-acts">
        {elsewhere ? (
          <button
            type="button"
            className="btn ghost"
            data-act="sign-in-show"
            onClick={() => chooseBrowserTab(owner, request.tabId)}
          >
            {t('browser.signIn.show')}
          </button>
        ) : null}
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
