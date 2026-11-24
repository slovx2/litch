// 收件箱与 X-n 引用的几句文字：事件种类、角色、原因、投递状态。设备给的原因码认不出时原样显示。
import {
  ChannelError,
  type ExternalEventKind,
  type ExternalInboxDelivery,
  type ExternalInboxEvent,
  githubExternalUrl,
} from '@litch/core'
import { Linking } from 'react-native'
import { actorName, knownReason } from '../../../../../../packages/ui/src/external/model.ts'
import type { Key, Translator } from '../../../ui/i18n'

export const kindLabel = (t: Translator, kind: ExternalEventKind) => t(`mgh.kind.${kind}` as Key)

export const roleLabel = (t: Translator, role: string | null | undefined) =>
  role === 'owner' ? t('mgh.role.owner') : (role ?? '—')

/** 行上的触发人：登录名（没有时是数字 ID）；多人时“甲 等 N 人” */
export function actorsLabel(t: Translator, actors: readonly string[]): string {
  const [name] = actors
  if (!name) return ''
  return actors.length > 1
    ? t('mgh.inbox.actors', { name, total: actors.length, others: actors.length - 1 })
    : name
}

/** 详情里的触发人：登录名在前，数字 ID 和核对时的仓库角色作补充 */
export function actorDetail(t: Translator, event: ExternalInboxEvent): string {
  const name = actorName(event)
  if (!name) return '—'
  return [
    name,
    event.actorLogin && event.actorId ? `#${event.actorId}` : '',
    event.actorRoleAtCheck
      ? t('mgh.inbox.roleTitle', { role: roleLabel(t, event.actorRoleAtCheck) })
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function reasonLabel(t: Translator, reason: string | undefined): string {
  const known = knownReason(reason)
  return known ? t(`mgh.reason.${known}` as Key) : (reason ?? '')
}

export const deliveryLabel = (t: Translator, delivery: ExternalInboxDelivery) =>
  t(`mgh.delivery.${delivery.state}` as Key)

/** 只打开设备核验过的 github.com 链接 */
export function openGithub(url: string): void {
  const safe = githubExternalUrl(url)
  if (safe) void Linking.openURL(safe).catch(() => {})
}

export function failureText(t: Translator, error: unknown): string {
  if (error instanceof ChannelError && error.text) return t.text(error.text)
  return error instanceof Error ? error.message : String(error)
}
