// 对话区顶上那一条细的状态（判断在 sync.ts）。浮在对话区上面、不占位置、不接触摸，出现和消失时内容不挪。
// 连接中、加载中前面一个小转圈，没连上前面是离线记号
import { type DeviceView, keys } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { SessionStore } from '../core/session-store'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { StatusShape } from '../ui/kit/marks'
import { useTheme } from '../ui/theme'
import { syncState } from './sync'

export function SyncBar({ store }: { store: SessionStore }) {
  const t = useT()
  const { c } = useTheme()
  const device = useKey<DeviceView>(keys.device(store.deviceId))
  const loaded = useSyncExternalStore(store.subscribeMeta, () => store.getMeta() !== null)
  const failed = useSyncExternalStore(store.subscribe, () => store.getSnapshot().error !== null)
  const state = syncState(device?.connection, loaded, failed)
  if (!state) return null
  return (
    <View
      pointerEvents="none"
      testID={`detail:sync:${state}`}
      style={[styles.bar, { backgroundColor: c.panel, borderColor: c.line1 }]}
    >
      {state === 'offline' ? (
        <StatusShape status="offline" size={12} color={c.wait} />
      ) : (
        <ActivityIndicator size="small" color={c.ink3} style={styles.spin} />
      )}
      <Text style={[styles.text, { color: state === 'offline' ? c.wait : c.ink3 }]}>
        {t(`detail.sync.${state}`)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 22,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // 系统转圈最小一档也比一行小字高，缩到和字一样高，细条不变厚
  spin: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  text: { fontSize: 12 },
})
