// 浏览器面板上的手动登录交接卡；用户交还前清理输入。
import { type ReactNode, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSignInAnswer,
  BrowserSignInRequest,
} from './bridge.ts'
import { SignInExpiry, SignInOrigin, useSignIns } from './SignInParts.tsx'
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
  const all = useSignIns(signIn)
  const [busy, setBusy] = useState(false)

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

/** 手动登录：选择交接，登录完成后交还。 */
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
  const manual = request.stage === 'manual'
  return (
    <div
      className="bw-signin"
      role="alert"
      data-sign-in={request.id}
      data-state="waiting"
      data-stage={request.stage}
    >
      <div className="bw-signin-text">
        <strong>{t('browser.signIn.title')}</strong>
        {origin}
        {claim}
        <span className="bw-signin-note">{t('browser.signIn.note')}</span>
        {request.expiresAt !== null ? <SignInExpiry expiresAt={request.expiresAt} /> : null}
      </div>
      <span className="bw-signin-acts">
        {show}
        <button
          type="button"
          className="btn"
          data-act={manual ? 'sign-in-done' : 'sign-in-self'}
          disabled={busy}
          onClick={() => void answer(manual ? 'done' : 'self')}
        >
          {t(manual ? 'browser.signIn.done' : 'browser.signIn.self')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="sign-in-cancel"
          disabled={busy}
          onClick={() => void answer('cancel')}
        >
          {t(manual ? 'browser.signIn.cancel' : 'browser.signIn.decline')}
        </button>
      </span>
    </div>
  )
}
