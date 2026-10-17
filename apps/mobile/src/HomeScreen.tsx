// 首页：设备状态、会话列表、几个造测试会话的按钮。轻页面，直接用 RN 写（2026-10-17 定的方向）。
import { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { CoreChannel, DeviceView, SessionSummary } from '../../../packages/core/src/index.mts'
import { DEVICE_ID } from './core/boot'
import { colors } from './detail/theme'

/** 发给假模型的记号（scripts/client-fixture-stream.mjs） */
export const PROMPTS = ['长回答', '长回答三倍', '十万字', '短回答'] as const

export const titleOf = (title: SessionSummary['title']): string =>
  typeof title === 'string' ? title : title.key

export function HomeScreen({
  channel,
  onOpen,
  onCreate,
  onBench,
}: {
  channel: CoreChannel
  onOpen(session: SessionSummary): void
  onCreate(prompt: string): void
  onBench(): void
}) {
  const insets = useSafeAreaInsets()
  const [device, setDevice] = useState<DeviceView | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  useEffect(() => {
    const offApp = channel.subscribe(
      { kind: 'app' },
      {
        snapshot: (view) => setDevice(view.devices.find((entry) => entry.id === DEVICE_ID) ?? null),
        delta: (ops) => {
          for (const op of ops) if (op.op === 'device.upsert' && op.device.id === DEVICE_ID) setDevice(op.device)
        },
      },
    )
    let current: SessionSummary[] = []
    const offSidebar = channel.subscribe(
      { kind: 'sidebar', deviceId: DEVICE_ID },
      {
        snapshot: (view) => {
          current = view.sessions
          setSessions([...current].sort((a, b) => b.updatedAt - a.updatedAt))
        },
        delta: (ops) => {
          let next = current
          for (const op of ops) {
            if (op.op === 'session.upsert') next = [...next.filter((s) => s.id !== op.session.id), op.session]
            else if (op.op === 'session.remove') next = next.filter((s) => s.id !== op.sessionId)
          }
          if (next === current) return
          current = next
          setSessions([...current].sort((a, b) => b.updatedAt - a.updatedAt))
        },
      },
    )
    return () => {
      offApp()
      offSidebar()
    }
  }, [channel])
  const failure = device?.failure ? JSON.stringify(device.failure).slice(0, 300) : null
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.device}>
        <Text style={styles.deviceName}>测试机 · {device?.host ?? '…'}</Text>
        <Text style={styles.deviceState} testID="device-state">
          {device?.connection ?? '启动中'}
          {device?.harnesses?.length ? ` · ${device.harnesses.map((h) => h.id).join('、')}` : ''}
        </Text>
        {failure ? <Text style={styles.failure}>{failure}</Text> : null}
      </View>
      <View style={styles.buttons}>
        {PROMPTS.map((prompt) => (
          <Pressable key={prompt} style={styles.button} onPress={() => onCreate(prompt)} testID={`new-${prompt}`}>
            <Text style={styles.buttonText}>新会话：{prompt}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.button} onPress={onBench} testID="webview-bench">
          <Text style={styles.buttonText}>WebView 吞吐</Text>
        </Pressable>
      </View>
      <FlatList
        data={sessions}
        keyExtractor={(session) => session.id}
        renderItem={({ item }) => (
          <Pressable style={styles.session} onPress={() => onOpen(item)}>
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {titleOf(item.title)}
            </Text>
            <Text style={styles.sessionMeta}>
              {item.status} · {new Date(item.updatedAt).toLocaleTimeString()}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  device: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  deviceName: { fontSize: 17, fontWeight: '600', color: colors.text },
  deviceState: { fontSize: 13, color: colors.muted, marginTop: 4 },
  failure: { fontSize: 12, color: '#CF222E', marginTop: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  button: { backgroundColor: colors.bar, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 14, color: colors.accent },
  session: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sessionTitle: { fontSize: 15, color: colors.text },
  sessionMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
})
