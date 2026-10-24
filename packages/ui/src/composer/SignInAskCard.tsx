// 对话里“代理请你登录”的卡片（客户端工具卡片里 ask.kind 是 signIn 的那种）。和浏览器面板上的 SignInCard
// 是同一张（ask.id 就是面板那张的编号）：经外壳 signIn.answer(id, …) 答，主进程的登记是准，不走核心的答复。
// 只在等人选的时候挂着：人在任何一处选了代填或者自己登录，主进程就撤掉这一张。
// 人不开浏览器面板也答得了：选账号由 Litch 代填；“我自己登录”打开浏览器面板换到那个标签；拒绝。
// 普通浏览器里（模拟核心）没有外壳，登录不了，只能拒绝（经核心的那个选项）。
import type { ClientAskRequest, SignInAskView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { type BrowserSignInAnswer, browserBridge } from '../side/browser/bridge.ts'
import {
  SignInAccounts,
  SignInBlocked,
  SignInExpiry,
  SignInOrigin,
  useSignIns,
} from '../side/browser/SignInParts.tsx'
import { BROWSER_TAB, chooseBrowserTab } from '../side/browser/store.ts'
import { showSideTab } from '../side/side.ts'
import { useCardFocus } from './focus.ts'
import { type CardProps, Foot, ownsKey, useRespond } from './respond.tsx'

export function SignInAskCard(props: CardProps<ClientAskRequest> & { ask: SignInAskView }) {
  const { request, waiting, ask, deviceId, sessionId } = props
  const t = useT()
  const card = useRef<HTMLElement>(null)
  const bridge = browserBridge()
  const core = useRespond(props)
  // 面板上那张：要它的标签（“我自己登录”换过去）
  const live = useSignIns(bridge?.signIn).find((one) => one.id === ask.id)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const hasAccounts = ask.accounts.length > 0
  const remote = request.device.kind === 'ssh'
  const locked = busy || core.busy || picked !== null

  /** 经外壳答；答到了主进程会撤掉这一张，不用放开 */
  const answer = (choice: BrowserSignInAnswer) => {
    if (!bridge) return
    setBusy(true)
    void bridge.signIn
      .answer(ask.id, choice)
      .catch(() => false)
      .then((ok) => {
        if (ok) return
        setBusy(false)
        setPicked(null)
      })
  }
  const decline = () => {
    if (bridge) answer('cancel')
    else {
      const option = request.options.find((one) => one.role === 'decline')
      if (option) core.respond({ optionId: option.id })
    }
  }
  /** 我自己登录：告诉主进程，再打开浏览器面板换到那个标签 */
  const self = () => {
    answer('self')
    if (live) chooseBrowserTab({ deviceId, threadId: sessionId }, live.tabId)
    showSideTab(BROWSER_TAB)
  }

  useCardFocus(card)

  // Esc 拒绝；回车不代填（登录要点明是哪个账号）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event, card.current) || event.key !== 'Escape' || locked) return
      event.preventDefault()
      decline()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <section
      className="req"
      ref={card}
      tabIndex={-1}
      aria-label={t('signInAsk.title')}
      data-client-ask="signIn"
      data-sign-in={ask.id}
      data-remote={remote}
      data-task={ask.taskId !== null ? 'true' : undefined}
    >
      <div className="req-head">
        <i className="st wait" />
        <span>{t('signInAsk.title')}</span>
      </div>
      <div className="req-body">
        {remote ? (
          <div className="req-why err" data-remote-note>
            {t('clientAsk.remote')}
          </div>
        ) : null}
        <div className="req-meta">
          <span>
            {t('clientAsk.from')} <b>{t.text(request.device.name)}</b>
            {remote ? <> · {request.device.host}</> : null}
          </span>
          <span>
            {t('clientAsk.tool')} <b>{`${request.tool.namespace} · ${request.tool.name}`}</b>
          </span>
          {ask.taskId !== null ? <span data-sign-in-task>{t('signInAsk.task')}</span> : null}
        </div>
        <div className="req-meta">
          <span>
            {t('clientAsk.origin')} <SignInOrigin origin={ask.origin} />
          </span>
        </div>
        <div className="req-why">
          {t('browser.signIn.claim', { site: ask.site, reason: ask.reason || '—' })}
        </div>
        {!bridge ? (
          <div className="req-why" data-desktop-only>
            {t('signInAsk.desktopOnly')}
          </div>
        ) : hasAccounts ? (
          <div className="req-why">{t('browser.signIn.chooseNote')}</div>
        ) : (
          <>
            <div className="req-why" data-sign-in-none>
              {t('browser.signIn.noAccounts')}
            </div>
            <div className="req-why">{t('signInAsk.noneNote')}</div>
          </>
        )}
        {hasAccounts && ask.fillBlocked !== null ? (
          <div className="req-why err">
            <SignInBlocked code={ask.fillBlocked} />
          </div>
        ) : null}
        {ask.expiresAt !== null ? (
          <div className="req-why">
            <SignInExpiry expiresAt={ask.expiresAt} />
          </div>
        ) : null}
        {hasAccounts ? (
          <SignInAccounts
            request={ask}
            busy={locked || !bridge}
            filling={picked}
            primary
            onFill={(ref, remember) => {
              setPicked(ref)
              answer({ fill: ref, remember })
            }}
          />
        ) : null}
      </div>
      <div className="req-actions">
        {bridge ? (
          <button
            type="button"
            className="btn"
            data-act="sign-in-self"
            disabled={locked}
            onClick={self}
          >
            {t('browser.signIn.self')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          data-act="sign-in-cancel"
          disabled={locked}
          onClick={decline}
        >
          {t('browser.signIn.decline')}
          <span className="kbd">Esc</span>
        </button>
      </div>
      <Foot waiting={waiting} error={core.error} />
    </section>
  )
}
