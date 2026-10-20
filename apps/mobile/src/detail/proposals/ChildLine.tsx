// 卡片底下那一行：实际起出来的子会话（状态点、名字、harness 和目录、状态），点了进去。
// 提案卡（已开始）和交接卡（交给了分叉会话）共用。子会话不在侧栏里了写“找不到了”，点不了。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { titleOf } from '../../screens/sessions/rows'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { StatusMark } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'

const MARK = { running: 'running', waiting: 'waiting', error: 'error', idle: 'idle' } as const

export function ChildLine({
  childId,
  fallback,
  testID,
}: {
  childId: string
  /** 子会话还没起名字时写的 */
  fallback: string
  testID: string
}) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const nameOf = (id: string) => device?.harnesses.find((entry) => entry.id === id)?.name ?? id
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t('tree.child.open')}
      disabled={!child}
      onPress={() => openSession(childId)}
      testID={testID}
      style={({ pressed }) => [
        styles.child,
        { borderTopColor: c.line1, backgroundColor: pressed ? c.press : 'transparent' },
      ]}
    >
      {child ? (
        <>
          <StatusMark status={MARK[child.status]} />
          <View style={styles.childText}>
            <Text numberOfLines={1} style={{ color: c.ink, fontSize: font.size.meta + 1 }}>
              {titleOf(child, t) || fallback}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.childMeta, { color: c.ink3, fontFamily: font.mono }]}
            >
              {[nameOf(child.harness), child.cwd].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Text style={[styles.childState, { color: c.ink3 }]}>
            {t(`tree.status.${child.status}`)} ›
          </Text>
        </>
      ) : (
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('tree.child.gone')}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  child: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  childText: { flex: 1, minWidth: 0 },
  childMeta: { fontSize: 11, marginTop: 2 },
  childState: { fontSize: 12 },
})
