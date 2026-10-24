// 登录卡片（浏览器面板上的 SignInCard、对话里的 composer/SignInAskCard）共用的几块：突出可注册域名的来源、
// “用某个账号登录”的一排按钮和定时任务的勾选、不能代填的原因、过期的倒计时。两处是同一张卡片的两个样子。
import { useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { useNow } from '../../app/clock.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { dayOf } from '../../settings/tools-logic.ts'
import type { BrowserSignInRequest } from './bridge.ts'
import { knownBlock, minutesLeft, originParts } from './sign-in-logic.ts'
import './sign-in.css'

/** 两处卡片都有的那几样（核心的 SignInAskView 也是这个形状） */
export type SignInShape = Pick<
  BrowserSignInRequest,
  'origin' | 'accounts' | 'fillBlocked' | 'taskId' | 'expiresAt'
>

/** 来源：可注册域名突出，前面的子域名和协议、后面的端口淡一点 */
export function SignInOrigin({ origin }: { origin: string }) {
  const t = useT()
  if (!origin) {
    return (
      <span className="bw-signin-origin mono" data-sign-in-origin>
        {t('browser.signIn.noOrigin')}
      </span>
    )
  }
  const { lead, main, tail } = originParts(origin)
  return (
    <span className="bw-signin-origin mono" data-sign-in-origin title={origin}>
      {lead ? <span className="bw-signin-dim">{lead}</span> : null}
      <b data-sign-in-domain>{main}</b>
      {tail ? <span className="bw-signin-dim">{tail}</span> : null}
    </span>
  )
}

const BLOCK_TEXT: Record<NonNullable<ReturnType<typeof knownBlock>>, MessageKey> = {
  insecure: 'browser.signIn.block.insecure',
  not_user_visible: 'browser.signIn.block.notVisible',
  locator_invalid: 'browser.signIn.block.locator',
  popup_needed: 'browser.signIn.block.popup',
  origin_changed: 'browser.signIn.block.origin',
  page_changed: 'browser.signIn.block.page',
  verification: 'browser.signIn.block.verification',
}

/** 预检不过：为什么不能代填 */
export function SignInBlocked({ code }: { code: string }) {
  const t = useT()
  const known = knownBlock(code)
  return (
    <span className="bw-signin-blocked" data-sign-in-blocked={code}>
      {t('browser.signIn.blocked', {
        reason: known ? t(BLOCK_TEXT[known]) : t('browser.signIn.block.other', { code }),
      })}
    </span>
  )
}

/** 定时任务的卡片：还剩几分钟过期 */
export function SignInExpiry({ expiresAt }: { expiresAt: number }) {
  const t = useT()
  const left = minutesLeft(expiresAt, useNow())
  return (
    <span className="bw-signin-expiry" data-sign-in-expires={left}>
      {left > 0 ? t('browser.signIn.expires', { minutes: left }) : t('browser.signIn.expired')}
    </span>
  )
}

/**
 * “用 {账号} 登录”一个账号一个按钮（不能代填时置灰），定时任务多一个“以后直接用这个账号”的勾选（默认不勾）。
 * filling 是点了的那个账号：它的按钮写“正在登录…”
 */
export function SignInAccounts({
  request,
  busy,
  filling,
  primary,
  onFill,
}: {
  request: SignInShape
  busy: boolean
  filling: string | null
  /** 头一个账号的按钮画成主按钮 */
  primary: boolean
  onFill(ref: string, remember: boolean): void
}) {
  const t = useT()
  const [remember, setRemember] = useState(false)
  const blocked = request.fillBlocked !== null
  return (
    <div className="bw-signin-accounts" data-sign-in-accounts={request.accounts.length}>
      {request.accounts.map((account, index) => (
        <button
          key={account.ref}
          type="button"
          className={primary && index === 0 && !blocked ? 'btn primary' : 'btn'}
          data-act="sign-in-fill"
          data-ref={account.ref}
          disabled={busy || blocked}
          title={
            account.lastUsed === null
              ? undefined
              : t('browser.signIn.lastUsed', { day: dayOf(account.lastUsed) })
          }
          onClick={() => onFill(account.ref, request.taskId !== undefined && remember)}
        >
          {filling === account.ref
            ? t('browser.signIn.filling')
            : t('browser.signIn.fill', {
                user: account.username === '' ? t('browser.signIn.noUser') : account.username,
              })}
        </button>
      ))}
      {request.taskId !== undefined ? (
        <label className="form-check bw-signin-remember">
          <input
            type="checkbox"
            data-act="sign-in-remember"
            checked={remember}
            disabled={busy || blocked}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>{t('browser.signIn.remember')}</span>
        </label>
      ) : null}
    </div>
  )
}
