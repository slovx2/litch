// 输入框上方（和后台任务、待办的小按钮排在一起）：这个会话里生效的限时授权，每类一个小胶囊，
// 写类别和剩多久，右边的叉撤销（撤销后立即恢复询问）。没有就不占地方。
import { timedRemaining } from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Icon } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { CATEGORY_TEXT, useTimedApprovals } from './timed'

/** 剩余时长按分钟显示，半分钟重画一次 */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function TimedChips({
  deviceId,
  sessionId,
  onError,
}: {
  deviceId: string
  sessionId: string
  onError(message: string): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const view = useTimedApprovals(deviceId)
  const now = useMinuteClock()
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
        onError(t('timed.revokeFailed', { reason: whyNot(failure, t) }))
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
        const what = t('timed.bar', { what: t(CATEGORY_TEXT[grant.category]) })
        return (
          <View
            key={grant.id}
            testID={`timed:chip:${grant.category}`}
            style={[styles.chip, { borderColor: c.accent, borderRadius: theme.radius.m }]}
          >
            <Icon name="clock" size={14} color={c.ink2} />
            <Text style={[styles.lead, { color: c.ink }]} numberOfLines={1}>
              {what}
            </Text>
            <Text style={[styles.left, { color: c.ink3 }]}>{t('timed.left', { left })}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('timed.revoke')} ${what}`}
              testID={`timed:revoke:${grant.category}`}
              disabled={revoking === grant.id}
              hitSlop={8}
              onPress={() => revoke(grant.id)}
              style={styles.x}
            >
              <Icon name="close" size={14} color={c.ink3} />
            </Pressable>
          </View>
        )
      })}
    </>
  )
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingLeft: 10,
    paddingRight: 4,
    marginBottom: 6,
    borderWidth: 1,
    maxWidth: '100%',
  },
  lead: { fontSize: 13, flexShrink: 1 },
  left: { fontSize: 12 },
  x: { padding: 4 },
})
