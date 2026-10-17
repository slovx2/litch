// 会话详情：标题栏、对话区、输入区。标题栏在首帧就是最终的样子（F1）；会话的数据只来自订阅（F2）。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { CoreChannel } from '../../../../packages/core/src/index.mts'
import { DEVICE_ID } from '../core/boot'
import { acquireStore, releaseStore } from '../core/store-cache'
import { experiment } from '../experiment'
import { COMPOSER_HEIGHT, Composer } from './Composer'
import { colors } from './theme'
import { Transcript, type Variant } from './Transcript'

export function DetailScreen({
  channel,
  sessionId,
  title,
  variant,
  markers,
  onBack,
  onVariant,
}: {
  channel: CoreChannel
  sessionId: string
  title: string
  variant: Variant
  markers: boolean
  onBack(): void
  onVariant(next: Variant): void
}) {
  const insets = useSafeAreaInsets()
  const store = useMemo(() => acquireStore(channel, DEVICE_ID, sessionId), [channel, sessionId])
  useEffect(() => () => releaseStore(store), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { running } = snapshot
  const [sendError, setSendError] = useState<string | null>(null)
  const send = (text: string) => {
    setSendError(null)
    channel.command('session.send', { deviceId: DEVICE_ID, sessionId, text }).catch((error: Error) => {
      setSendError(error.message)
    })
  }
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.headerButton} testID="detail-back">
          <Text style={styles.headerAction}>返回</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={() => onVariant(variant === 'A' ? 'B' : 'A')} style={styles.headerButton}>
          <Text style={styles.headerAction}>列表 {variant}</Text>
        </Pressable>
      </View>
      {snapshot.error || sendError ? (
        <Text style={styles.error} numberOfLines={2}>
          {snapshot.error ?? sendError}
        </Text>
      ) : null}
      {variant === 'A' && experiment.keyboard === 'sticky' ? (
        // 对话区和输入区用同一个偏移跟着键盘平移，在 UI 线程上同一帧动，两者之间的距离一直不变；
        // 顶上移出去的那一截藏到标题栏后面（标题栏压在上面）
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.list}>
          <Transcript store={store} variant={variant} bottomOffset={insets.bottom} markers={markers} />
        </KeyboardStickyView>
      ) : (
        <Transcript
          key={variant}
          store={store}
          variant={variant}
          bottomOffset={insets.bottom}
          markers={markers}
        />
      )}
      <Composer bottomInset={insets.bottom} markers={markers} busy={running} onSend={send} />
    </View>
  )
}

export const HEADER_HEIGHT = 48
export { COMPOSER_HEIGHT }

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bar,
    zIndex: 1,
  },
  list: { flex: 1 },
  headerButton: { paddingHorizontal: 14, height: HEADER_HEIGHT, justifyContent: 'center' },
  headerAction: { color: colors.accent, fontSize: 15 },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: colors.text },
  error: { color: '#CF222E', paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
})
