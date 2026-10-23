// 会话列表顶上的横条：设备没连着（在连、重连、离线、没连上）时说是哪一种和原因，给“重试”；
// 列表是上次留下的（stale）时说明只能看。连着而且数据是新的就什么都不画。
import { type DeviceView, keys } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

const STATE_KEY = {
  connecting: 'sidebar.connecting',
  reconnecting: 'sidebar.reconnecting',
  offline: 'sidebar.offline',
  error: 'sidebar.failed',
} as const

export function DeviceBanner({ deviceId }: { deviceId: string }) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const channel = useChannel()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  if (!device) return null
  const down = device.connection !== 'online'
  if (!down && !device.stale && !device.note) return null
  const lines: string[] = []
  if (down) {
    const state = t(STATE_KEY[device.connection as keyof typeof STATE_KEY])
    lines.push(device.note ? t('sessions.banner', { state, note: t.text(device.note) }) : state)
  } else if (device.note) lines.push(t.text(device.note))
  if (device.stale) lines.push(t('sidebar.stale'))
  // 正在连的第一步不给重试：点了也只是再连一次
  const retry = down && device.connection !== 'connecting'
  return (
    <View
      testID="sessions:banner"
      style={[
        styles.banner,
        { backgroundColor: c.sunken, borderBottomColor: down ? c.wait : c.line2 },
      ]}
    >
      <View style={styles.text}>
        {lines.map((line) => (
          <Text key={line} style={[styles.line, { color: down ? c.wait : c.ink2 }]}>
            {line}
          </Text>
        ))}
      </View>
      {retry ? (
        <Pressable
          accessibilityRole="button"
          testID="sessions:reconnect"
          hitSlop={8}
          onPress={() => void channel.command('device.reconnect', { deviceId }).catch(() => {})}
          style={[styles.retry, { borderColor: c.line3, borderRadius: theme.radius.m }]}
        >
          <Text style={[styles.retryText, { color: c.ink }]}>{t('sidebar.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 2,
  },
  text: { flex: 1, gap: 2 },
  line: { fontSize: 13, lineHeight: 18 },
  retry: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  retryText: { fontSize: 13, fontWeight: '600' },
})
