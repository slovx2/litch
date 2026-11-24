// 输入框上方：这个会话里生效的限时授权，每类一个小条（类别、剩多久、撤销）。没有就不占地方。
import { timedRemaining } from '@litch/core'
import { useState } from 'react'
import { useAppearance, useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { reasonOf } from '../app/errors.ts'
import { Close, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { CATEGORY_TEXT, untilText, useTimedApprovals } from './timed.ts'

export function TimedBar({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const { lang } = useAppearance()
  const now = useNow()
  const { channel } = useServices()
  const view = useTimedApprovals(deviceId)
  const [revoking, setRevoking] = useState<string | null>(null)
  const grants = (view?.grants ?? []).filter(
    (grant) => grant.threadId === sessionId && grant.expiresAt > now,
  )
  if (!grants.length) return null
  const revoke = (id: string) => {
    setRevoking(id)
    channel.command('timedApproval.revoke', { deviceId, id }).then(
      () => setRevoking(null),
      (failure: unknown) => {
        setRevoking(null)
        showToast({
          id: 'timed-revoke',
          tone: 'err',
          lifeMs: 6000,
          text: (tr) => tr('timed.revokeFailed', { reason: reasonOf(failure, tr) }),
        })
      },
    )
  }
  return (
    <>
      {grants.map((grant) => {
        const { hours, minutes } = timedRemaining(grant.expiresAt, now)
        const left = hours
          ? minutes
            ? t('timed.left.hm', { hours, minutes })
            : t('timed.left.h', { hours })
          : t('timed.left.m', { minutes: Math.max(1, minutes) })
        return (
          <span
            key={grant.id}
            className="timedbar"
            data-timed={grant.category}
            title={t('timed.barTitle', { time: untilText(grant.expiresAt, now, lang) })}
          >
            <Icon name="clock" small />
            <span className="lead">
              {t('timed.bar', { what: t(CATEGORY_TEXT[grant.category]) })}
            </span>
            <span className="left">{t('timed.left', { left })}</span>
            <button
              type="button"
              className="x"
              aria-label={t('timed.revoke')}
              title={t('timed.revoke')}
              disabled={revoking === grant.id}
              onClick={() => revoke(grant.id)}
            >
              <Close />
            </button>
          </span>
        )
      })}
    </>
  )
}
