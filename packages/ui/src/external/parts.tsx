// 无人值守各处共用的小件：头像、状态点、外部链接图标按钮、开关。
import { githubExternalUrl } from '@litch/core'
import type { ReactNode } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { useAvatar } from './data.ts'
import type { SourceState } from './model.ts'

export function Avatar({ userId, login }: { userId?: string | undefined; login: string }) {
  const src = useAvatar(userId)
  return src ? (
    <img className="ext-avatar" src={src} alt="" />
  ) : (
    <span className="ext-avatar" aria-hidden="true">
      {login.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** 状态点：ok 绿、wait 黄、err 红、off 灰；文字放悬停提示和读屏 */
export type DotTone = 'ok' | 'wait' | 'err' | 'off'
export function Dot({ tone, label }: { tone: DotTone; label: string }) {
  return <i className="ext-dot" data-tone={tone} title={label} role="img" aria-label={label} />
}

export const sourceTone: Record<SourceState, DotTone> = {
  collecting: 'ok',
  paused: 'off',
  backoff: 'wait',
  blocked: 'err',
}
export const readinessTone = { ok: 'ok', blocked: 'err', unverified: 'off' } as const

/** 打开 GitHub 链接：只认设备给的 github.com 链接，其余不成链接；有 children 时是文字链接 */
export function ExtLink({
  url,
  label,
  children,
}: {
  url: string
  label?: string
  children?: ReactNode
}) {
  const t = useT()
  const href = githubExternalUrl(url)
  if (!href) return children ? <span>{children}</span> : null
  if (children)
    return (
      <ExternalLink className="ext-text-link" href={href} title={label ?? href}>
        {children}
      </ExternalLink>
    )
  return (
    <ExternalLink
      className="ibtn ext-link"
      href={href}
      title={label ?? t('ext.open')}
      aria-label={label ?? t('ext.open')}
    >
      <Icon name="globe" small />
    </ExternalLink>
  )
}

export function Switch({
  checked,
  label,
  disabled,
  onChange,
  act,
  title,
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange(next: boolean): void
  act?: string
  /** 悬停提示：不能点时写原因 */
  title?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      data-act={act}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  )
}

/** 一行“名字 … 控件”，设置类小表格用 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ext-field">
      <span className="ext-field-label">{label}</span>
      <span className="ext-field-value">{children}</span>
    </div>
  )
}
