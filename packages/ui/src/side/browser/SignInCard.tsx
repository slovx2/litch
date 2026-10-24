// 浏览器面板上的“代理请你登录”：代理调了 request_sign_in，标签对代理冻住，这里等人答。画在 Litch 的界面里、网页上面，
// 网页和代理都看不到。醒目的是外壳取到的真实来源（随导航更新，突出可注册域名），代理说的站点名和原因只作附注。
// 先让人选（stage: choose）：密码库里有这个网站的账号时是“用 {账号} 登录 / 我自己登录 / 拒绝”，选账号由 Litch
// 代填代提交（filling），代理拿不到密码；预检不过时账号按钮置灰并写原因；定时任务的回合多一个“以后直接用这个账号”的
// 勾选和过期时间。选了自己登录（manual），人在网页里自己登录（能用已保存的密码），点“完成，交还”或“取消”。
// 对话里同时有一张（composer/SignInAskCard.tsx），只在 choose 时挂着；任何一处答了，主进程的登记是准，两处一起变。
// 交还之前外壳会清空密码框，代理只知道人点了哪个。代理不等了（回合打断、结束）时卡片变成“代理已收回”，
// 提醒别再在这里输入，点“知道了”才没；这一页没能安全地重新打开时标签被关掉，卡片变成“标签已关掉”，不再有“显示”。
import { type ReactNode, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSignInAnswer,
  BrowserSignInRequest,
} from './bridge.ts'
import {
  SignInAccounts,
  SignInBlocked,
  SignInExpiry,
  SignInOrigin,
  useSignIns,
} from './SignInParts.tsx'
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

/**
 * 等人答的那张，按主进程给的 stage 画。choose：有已存账号时是“用 {账号} 登录 / 我自己登录 / 拒绝”，
 * 库里没有账号时只有“我自己登录 / 拒绝”；预检不过时账号按钮置灰并写原因。manual：人选了自己登录，
 * 在网页里登录完点“完成，交还”或“取消”。filling：Litch 正在代填，没有按钮（手机批的写明是哪台）
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
  /** 点了哪个账号，主进程还没换成 filling */
  const [picked, setPicked] = useState<string | null>(null)
  const hasAccounts = request.accounts.length > 0
  const { stage } = request

  const fill = (ref: string, remember: boolean) => {
    setPicked(ref)
    void answer({ fill: ref, remember }).then((ok) => {
      if (!ok) setPicked(null)
    })
  }
  const locked = busy || picked !== null

  const head = (
    <div className="bw-signin-text">
      <strong>
        {t(stage === 'filling' ? 'browser.signIn.fillingTitle' : 'browser.signIn.title')}
      </strong>
      {origin}
      {claim}
      {stage === 'filling' ? (
        <>
          {request.by && request.by !== 'desktop' ? (
            <span className="bw-signin-note" data-sign-in-phone={request.by.phoneId}>
              {t('browser.signIn.fillingPhone', { name: request.by.name })}
            </span>
          ) : null}
          <span className="bw-signin-note">{t('browser.signIn.fillingNote')}</span>
        </>
      ) : stage === 'manual' ? (
        <span className="bw-signin-note">{t('browser.signIn.note')}</span>
      ) : hasAccounts ? (
        <span className="bw-signin-note">{t('browser.signIn.chooseNote')}</span>
      ) : (
        <>
          <span className="bw-signin-note" data-sign-in-none>
            {t('browser.signIn.noAccounts')}
          </span>
          <span className="bw-signin-note">{t('browser.signIn.noneNote')}</span>
        </>
      )}
      {stage === 'choose' && hasAccounts && request.fillBlocked !== null ? (
        <SignInBlocked code={request.fillBlocked} />
      ) : null}
      {stage !== 'filling' && request.expiresAt !== null ? (
        <SignInExpiry expiresAt={request.expiresAt} />
      ) : null}
    </div>
  )

  return (
    <div
      className="bw-signin"
      role="alert"
      data-sign-in={request.id}
      data-state="waiting"
      data-stage={stage}
      data-task={request.taskId !== null ? 'true' : undefined}
    >
      {head}
      {stage === 'choose' && hasAccounts ? (
        <SignInAccounts request={request} busy={locked} filling={picked} primary onFill={fill} />
      ) : null}
      {stage === 'filling' ? (
        <span className="bw-signin-acts">{show}</span>
      ) : (
        <span className="bw-signin-acts">
          {show}
          {stage === 'choose' ? (
            <button
              type="button"
              className="btn"
              data-act="sign-in-self"
              disabled={locked}
              onClick={() => void answer('self')}
            >
              {t('browser.signIn.self')}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              data-act="sign-in-done"
              disabled={locked}
              onClick={() => void answer('done')}
            >
              {t('browser.signIn.done')}
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            data-act="sign-in-cancel"
            disabled={locked}
            onClick={() => void answer('cancel')}
          >
            {t(stage === 'choose' ? 'browser.signIn.decline' : 'browser.signIn.cancel')}
          </button>
        </span>
      )}
    </div>
  )
}
