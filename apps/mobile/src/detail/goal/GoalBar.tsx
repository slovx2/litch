// 输入框上方的目标那一行（照桌面的 goal/GoalBar.tsx）：harness 会持续目标、会话有目标时出现，停下了也在；
// 达成了核心马上清掉，这一行跟着没了（回答下面那一句是 GoalReachedCell）。
// 上面一排：靶的记号、状态、用量（有预算时写词元，否则写用时，在做时每秒走），右边暂停或继续（预算用完的没有）、清除；
// 下面是目标的话，两行截断，点一下看全文。清除不弹确认。按钮该不该出、用量怎么写都用桌面的 goal/logic.ts
import type { GoalStatus, SessionGoalView } from '@litch/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  compactTokens,
  goalElapsedMs,
  goalTime,
  toggleTarget,
  usageKind,
} from '../../../../../packages/ui/src/goal/logic.ts'
import type { SessionStore } from '../../core/session-store'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function GoalBar({ store, onError }: { store: SessionStore; onError(text: string): void }) {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const goal = meta?.can.goals ? meta.goal : null
  if (!goal) return null
  return <GoalLine store={store} goal={goal} onError={onError} />
}

function GoalLine({
  store,
  goal,
  onError,
}: {
  store: SessionStore
  goal: SessionGoalView
  onError(text: string): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const channel = useChannel()
  const [open, setOpen] = useState(false)
  const now = useTicking(goal.status === 'active')
  const next = toggleTarget(goal.status)
  const usage =
    usageKind(goal) === 'tokens'
      ? t('goal.tokens', {
          used: compactTokens(goal.tokensUsed),
          budget: compactTokens(goal.tokenBudget ?? 0),
        })
      : t('goal.spent', { time: goalTime(goalElapsedMs(goal, now), t) })
  const ref = { deviceId: store.deviceId, sessionId: store.sessionId }
  const run = (work: Promise<unknown>, failed: 'goal.failed.update' | 'goal.failed.clear') =>
    work.catch((reason: unknown) => onError(t(failed, { reason: whyNot(reason, t) })))
  return (
    <View
      testID="goal:bar"
      style={[styles.bar, { borderColor: c.line3, borderRadius: theme.radius }]}
    >
      <View style={styles.head}>
        <Text style={[styles.mark, { color: markColor(goal.status, c) }]}>◎</Text>
        <Text
          testID={`goal:status:${goal.status}`}
          numberOfLines={1}
          style={[styles.state, { color: c.ink, fontSize: font.size.meta }]}
        >
          {t(`goal.status.${goal.status}`)}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.use, { color: c.ink3, fontSize: font.size.small, fontFamily: font.mono }]}
        >
          {usage}
        </Text>
        <View style={styles.acts}>
          {next ? (
            <Act
              testID={next === 'paused' ? 'goal:pause' : 'goal:resume'}
              label={t(next === 'paused' ? 'goal.pause' : 'goal.resume')}
              onPress={() =>
                void run(
                  channel.command('session.goal.set', { ...ref, status: next }),
                  'goal.failed.update',
                )
              }
            />
          ) : null}
          <Act
            testID="goal:clear"
            label={t('goal.clear')}
            onPress={() =>
              void run(channel.command('session.goal.clear', ref), 'goal.failed.clear')
            }
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        testID="goal:text"
        onPress={() => setOpen((value) => !value)}
      >
        <Text
          numberOfLines={open ? undefined : 2}
          style={[styles.text, { color: c.ink2, fontSize: font.size.meta }]}
        >
          {goal.objective}
        </Text>
      </Pressable>
    </View>
  )
}

function Act({ label, testID, onPress }: { label: string; testID: string; onPress(): void }) {
  const { c, font } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={6}
      onPress={onPress}
      style={styles.act}
    >
      <Text numberOfLines={1} style={{ color: c.accent, fontSize: font.size.small }}>
        {label}
      </Text>
    </Pressable>
  )
}

const markColor = (status: GoalStatus, c: ReturnType<typeof useTheme>['c']): string =>
  status === 'active'
    ? c.accent
    : status === 'complete'
      ? c.ok
      : status === 'paused'
        ? c.ink3
        : c.wait

/** 在做的目标用时一秒一秒地走：从上次更新起的那一截对面还没记进去 */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    gap: 2,
  },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8 },
  mark: { fontSize: 14 },
  state: { fontWeight: '600', flexShrink: 1 },
  use: { flexShrink: 1 },
  acts: { flexDirection: 'row', gap: 14, marginLeft: 'auto' },
  act: { paddingVertical: 4 },
  text: { lineHeight: 18 },
})
