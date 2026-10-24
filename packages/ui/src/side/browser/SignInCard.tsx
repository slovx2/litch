// 浏览器面板上的“代理请你登录”：代理调了 request_sign_in，标签对代理冻住，这里等人答。画在 Litch 的界面里、网页上面，
// 网页和代理都看不到。醒目的是外壳取到的真实来源（随导航更新，突出可注册域名），代理说的站点名和原因只作附注。
// 密码库里有这个网站的账号时先给“用 {账号} 登录 / 我自己登录 / 拒绝”：选账号由 Litch 代填代提交，代理拿不到密码；
// 预检不过时账号按钮置灰并写原因；定时任务的回合多一个“以后直接用这个账号”的勾选和过期时间。
// 选了自己登录、或者库里没有账号时，人在网页里自己登录（能用已保存的密码），点“完成，交还”或“取消”。
// 对话里同时有一张同样的（composer/SignInAskCard.tsx），任何一处答了两处都收掉；“我自己登录”两处一起换（sign-in-choice.ts）。
// 交还之前外壳会清空密码框，代理只知道人点了哪个。代理不等了（回合打断、结束）时卡片变成“代理已收回”，
// 提醒别再在这里输入，点“知道了”才没；这一页没能安全地重新打开时标签被关掉，卡片变成“标签已关掉”，不再有“显示”。
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSignInAnswer,
  BrowserSignInRequest,
} from './bridge.ts'
import { SignInAccounts, SignInBlocked, SignInExpiry, SignInOrigin } from './SignInParts.tsx'
import { chooseSelf, useChoseSelf } from './sign-in-choice.ts'
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

  /** 答一下；回答没答到（卡片已经没了、主进程不认） */
  const answer = (choice: BrowserSignInAnswer): Promise<boolean> => {
    setBusy(true)
    return signIn
      .answer(request.id, choice)
      .catch(() => false)
      .finally(() => setBusy(false))
  }
  const elsewhere = request.tabId !== currentTabId && request.state !== 'closed'
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
  const origin = <SignInOrigin origin={request.origin} />
  const claim = (
    <span className="bw-signin-claim">
      {t('browser.signIn.claim', {
        site: request.site,
        reason: request.reason || '—',
      })}
    </span>
  )
  if (request.state !== 'waiting') {
    const closed = request.state === 'closed'
    return (
      <div
        className="bw-signin withdrawn"
        role="alert"
        data-sign-in={request.id}
        data-state={request.state}
      >
        <div className="bw-signin-text">
          <strong>{t(closed ? 'browser.signIn.closed' : 'browser.signIn.withdrawn')}</strong>
          {origin}
          <span className="bw-signin-note">
            {t(closed ? 'browser.signIn.closedNote' : 'browser.signIn.withdrawnNote')}
          </span>
        </div>
        <span className="bw-signin-acts">
          {show}
          <button
            type="button"
            className="btn"
            data-act="sign-in-dismiss"
            disabled={busy}
            onClick={() => void answer('dismiss')}
          >
            {t('browser.signIn.dismiss')}
          </button>
        </span>
      </div>
    )
  }
  return (
    <Waiting
      request={request}
      busy={busy}
      show={show}
      origin={origin}
      claim={claim}
      answer={answer}
    />
  )
}

/**
 * 等人答的那张。有已存账号时先给“用 {账号} 登录 / 我自己登录 / 拒绝”；选了自己登录、或者库里没有这个网站的账号时，
 * 是原来那一版（在网页里登录，点“完成，交还”或“取消”）。预检不过时账号按钮置灰并写原因
 */
function Waiting({
  request,
  busy,
  show,
  origin,
  claim,
  answer,
}: {
  request: BrowserSignInRequest
  busy: boolean
  show: ReactNode
  origin: ReactNode
  claim: ReactNode
  answer(choice: BrowserSignInAnswer): Promise<boolean>
}) {
  const t = useT()
  const self = useChoseSelf(request.id)
  /** 点了哪个账号，主进程还没收卡片 */
  const [filling, setFilling] = useState<string | null>(null)
  const hasAccounts = request.accounts.length > 0
  const mode = self || !hasAccounts ? 'self' : 'choose'

  const fill = (ref: string, remember: boolean) => {
    setFilling(ref)
    void answer({ fill: ref, remember }).then((ok) => {
      if (!ok) setFilling(null)
    })
  }
  const locked = busy || filling !== null

  return (
    <div
      className="bw-signin"
      role="alert"
      data-sign-in={request.id}
      data-state="waiting"
      data-mode={mode}
      data-task={request.taskId !== undefined ? 'true' : undefined}
    >
      <div className="bw-signin-text">
        <strong>{t('browser.signIn.title')}</strong>
        {origin}
        {claim}
        {mode === 'choose' ? (
          <span className="bw-signin-note">{t('browser.signIn.chooseNote')}</span>
        ) : (
          <>
            {hasAccounts ? null : (
              <span className="bw-signin-note" data-sign-in-none>
                {t('browser.signIn.noAccounts')}
              </span>
            )}
            <span className="bw-signin-note">{t('browser.signIn.note')}</span>
          </>
        )}
        {mode === 'choose' && request.fillBlocked !== null ? (
          <SignInBlocked code={request.fillBlocked} />
        ) : null}
        {request.expiresAt !== undefined ? <SignInExpiry expiresAt={request.expiresAt} /> : null}
      </div>
      {mode === 'choose' ? (
        <SignInAccounts request={request} busy={locked} filling={filling} primary onFill={fill} />
      ) : null}
      <span className="bw-signin-acts">
        {show}
        {mode === 'choose' ? (
          <button
            type="button"
            className="btn"
            data-act="sign-in-self"
            disabled={locked}
            onClick={() => chooseSelf(request.id, true)}
          >
            {t('browser.signIn.self')}
          </button>
        ) : (
          <>
            {hasAccounts ? (
              <button
                type="button"
                className="btn ghost"
                data-act="sign-in-back"
                disabled={locked}
                onClick={() => chooseSelf(request.id, false)}
              >
                {t('browser.signIn.back')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              data-act="sign-in-done"
              disabled={locked}
              onClick={() => void answer('done')}
            >
              {t('browser.signIn.done')}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn ghost"
          data-act="sign-in-cancel"
          disabled={locked}
          onClick={() => void answer('cancel')}
        >
          {t(mode === 'choose' ? 'browser.signIn.decline' : 'browser.signIn.cancel')}
        </button>
      </span>
    </div>
  )
}
