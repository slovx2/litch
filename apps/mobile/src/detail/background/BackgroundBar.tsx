// 输入框上方的一行：后台还有任务在跑时出现，只说有几个在跑，整条一起慢呼吸（减少动态效果时不动）。
// 点一下从底部弹出列表（和桌面右侧的“后台任务”页同样的内容）：运行中在上、已结束在下，每行名称、用时、状态，
// 组头写跑完会不会自动接着做；不展开详情。人接着说话、新回合在跑时照样在（后台的任务没有停），全部跑完就没了。
// 对面报集合的照侧栏摘要（SessionSummary.background），不报的用会话存储派生的那一份（meta.derived）。
import {
  type BackgroundTaskView,
  backgroundHint,
  keys,
  type SessionBackgroundView,
  type SessionSummary,
} from '@litch/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { duration } from '../../../../../packages/ui/src/app/format.ts'
import type { SessionStore } from '../../core/session-store'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useBreath } from '../../ui/kit/breath'
import { useTheme } from '../../ui/theme'

/** 这个会话的后台任务：报集合的照摘要，不报的照派生 */
export function useSessionBackground(store: SessionStore): SessionBackgroundView | null {
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const summary = useKey<SessionSummary>(keys.summary(store.deviceId, store.sessionId))
  if (meta && !meta.can.backgroundTasks) return meta.derived
  return summary?.background ?? null
}

export function BackgroundBar({ store }: { store: SessionStore }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const background = useSessionBackground(store)
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(false)
  const breath = useBreath(pressed)
  const count = backgroundHint(background)
  const shown = count > 0
  // 底色跟着呼吸一明一暗：呼吸值 1 → 0.35 对应底色的浓淡 0.06 → 0.2
  const glow = breath.interpolate({ inputRange: [0.35, 1], outputRange: [0.2, 0.06] })
  return (
    <>
      {shown ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('background.bar', { count })}
          testID="background:bar"
          onPress={() => setOpen(true)}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={[styles.bar, { borderColor: c.accent, borderRadius: theme.radius.m }]}
        >
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: c.accent, opacity: glow }]}
          />
          <Animated.View style={[styles.dot, { backgroundColor: c.accent, opacity: breath }]} />
          <Text style={[styles.lead, { color: c.ink }]}>{t('background.bar', { count })}</Text>
          <Text style={{ color: c.ink3 }}>›</Text>
        </Pressable>
      ) : null}
      <BackgroundSheet
        visible={open && (background?.tasks.length ?? 0) > 0}
        background={background}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function BackgroundSheet({
  visible,
  background,
  onClose,
}: {
  visible: boolean
  background: SessionBackgroundView | null
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  // 在跑的用时一秒一秒地走：开着的时候才走
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])
  const tasks = background?.tasks ?? []
  const running = tasks.filter((task) => task.status === 'running')
  const ended = tasks.filter((task) => task.status !== 'running')
  const wakes = background?.wakesOnFinish ?? null
  const head = (label: string, n: number, note: string | null, testID: string) => (
    <View style={styles.group} testID={testID}>
      <Text style={[styles.groupText, { color: c.ink3 }]}>{label}</Text>
      <Text style={[styles.groupCount, { color: c.ink2, fontFamily: theme.font.mono }]}>{n}</Text>
      {note ? (
        <Text numberOfLines={1} style={[styles.groupNote, { color: c.ink3 }]}>
          {note}
        </Text>
      ) : null}
    </View>
  )
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="background:scrim" />
      <View
        testID="background:sheet"
        style={[
          styles.sheet,
          { backgroundColor: c.raised, borderColor: c.line3, paddingBottom: insets.bottom + 8 },
        ]}
      >
        <Text style={[styles.title, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {t('side.tab.background')}
        </Text>
        <ScrollView style={styles.list}>
          {running.length > 0 ? (
            <>
              {head(
                t('background.running'),
                running.length,
                wakes === null ? null : t(wakes ? 'background.wakes' : 'background.noWake'),
                'background:running',
              )}
              {running.map((task) => (
                <TaskRow key={task.id} task={task} now={now} />
              ))}
            </>
          ) : (
            <Text style={[styles.empty, { color: c.ink3 }]}>{t('background.none')}</Text>
          )}
          {ended.length > 0 ? (
            <>
              {head(t('background.ended'), ended.length, null, 'background:ended')}
              {ended.map((task) => (
                <TaskRow key={task.id} task={task} now={now} />
              ))}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  )
}

function TaskRow({ task, now }: { task: BackgroundTaskView; now: number }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const elapsed = task.startedAt === null ? null : (task.endedAt ?? now) - task.startedAt
  const color =
    task.status === 'running'
      ? c.accent
      : task.status === 'failed'
        ? c.err
        : task.status === 'completed'
          ? c.ok
          : c.ink3
  return (
    <View
      style={[styles.row, { borderTopColor: c.line1 }]}
      testID={`background:task:${task.status}`}
    >
      <Text
        numberOfLines={1}
        style={[styles.rowTitle, { color: c.ink2, fontFamily: theme.font.mono }]}
      >
        {task.title}
      </Text>
      {elapsed === null ? null : (
        <Text style={[styles.meta, { color: c.ink3, fontFamily: theme.font.mono }]}>
          {duration(Math.max(0, elapsed), t)}
        </Text>
      )}
      <Text style={[styles.meta, { color, fontFamily: theme.font.mono }]}>
        {t(`background.status.${task.status}`)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 32,
    paddingHorizontal: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
    overflow: 'hidden',
  },
  dot: { width: 7, height: 7 },
  lead: { fontSize: 13, fontWeight: '500' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopWidth: 1, maxHeight: '70%' },
  title: { fontSize: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  list: { flexGrow: 0 },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  groupText: { fontSize: 12 },
  groupCount: { fontSize: 12 },
  groupNote: { flex: 1, fontSize: 12, textAlign: 'right' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 13 },
  meta: { fontSize: 12 },
  empty: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
})
