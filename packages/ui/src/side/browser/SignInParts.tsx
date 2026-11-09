// 手动登录卡共用来源显示与过期倒计时。
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { useNow } from '../../app/clock.ts'
import type { BrowserSignInBridge, BrowserSignInRequest } from './bridge.ts'
import { minutesLeft, originParts } from './sign-in-logic.ts'
import './sign-in.css'

/** 两处卡片都有的那几样（核心的 SignInAskView 也是这个形状） */
export type SignInShape = Pick<
  BrowserSignInRequest,
  'origin' | 'accounts' | 'fillBlocked' | 'taskId' | 'expiresAt'
>

/** 外壳登记着的所有登录卡片，变了跟着变 */
export function useSignIns(signIn: BrowserSignInBridge | undefined): BrowserSignInRequest[] {
  const [all, setAll] = useState<BrowserSignInRequest[]>([])
  useEffect(() => {
    if (!signIn) return
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
  return all
}

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
