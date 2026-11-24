// 用户身份授权对人说的几句：桌面和手机共用（手机的 t 是桌面文案的超集），不碰 DOM 与 React。
import { stamp } from '../app/format.ts'
import type { Translator } from '../i18n/index.ts'
import { type FeishuUserGrant, grantError, grantShown, timeLeft } from './model.ts'
import { timeLeftText } from './speech-text.ts'

/** 状态一词：未授权、待本人同意、已授权、授权已失效、授权已撤销、授权失败 */
export function grantStateText(t: Translator, grant: FeishuUserGrant | null): string {
  return t(`feishu.grant.state.${grantShown(grant)}`)
}

/** 失效、撤销、失败的原因一句；没有要说的是 null */
export function grantErrorText(t: Translator, grant: FeishuUserGrant | null): string | null {
  const reason = grantError(grant)
  return reason ? t(`feishu.grant.error.${reason}`, { code: grant?.error ?? '' }) : null
}

/** 次要信息（放悬停或详情）：授权时间、最近使用、刷新时间、撤销时间、权限数；都没有时是空串 */
export function grantDetailText(
  t: Translator,
  grant: FeishuUserGrant | null,
  nowMs: number,
): string {
  if (!grant) return ''
  const at = (
    key:
      | 'feishu.grant.grantedAt'
      | 'feishu.grant.lastUsedAt'
      | 'feishu.grant.refreshedAt'
      | 'feishu.grant.revokedAt',
    time: number | undefined,
  ) => (time ? t(key, { time: stamp(time * 1000, nowMs, t.lang) }) : '')
  return [
    at('feishu.grant.grantedAt', grant.grantedAt),
    at('feishu.grant.lastUsedAt', grant.lastUsedAt),
    at('feishu.grant.refreshedAt', grant.refreshedAt),
    at('feishu.grant.revokedAt', grant.revokedAt),
    grant.scopes.length ? t('feishu.grant.scopes', { n: grant.scopes.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 链接的有效期：“剩 4 分钟，14:32 过期”；已过期写“链接已过期” */
export function grantLinkLeftText(
  t: Translator,
  pending: NonNullable<FeishuUserGrant['pending']>,
  nowMs: number,
): string {
  const left = timeLeft(pending.expiresAt, nowMs)
  if (!left) return t('feishu.grant.linkExpired')
  return t('feishu.grant.linkLeft', {
    left: timeLeftText(t, left),
    time: stamp(pending.expiresAt * 1000, nowMs, t.lang),
  })
}
