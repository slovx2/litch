// 会话详情：标题栏、对话区、输入区。标题栏在首帧就是最终的样子（F1，标题从路由参数来）；会话的数据只来自订阅（F2）。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { acquireStore, releaseStore } from '../core/store-cache'
import { experiment } from '../experiment'
import type { RootStackParamList } from '../nav/routes'
import { useChannel } from '../shell/services'
import { Screen } from '../ui/kit/Screen'
import { useTheme } from '../ui/theme'
import { Composer } from './Composer'
import { Transcript } from './Transcript'

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>

export function DetailScreen({ route }: Props) {
  const { deviceId, sessionId, title } = route.params
  const channel = useChannel()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  const store = useMemo(
    () => acquireStore(channel, deviceId, sessionId),
    [channel, deviceId, sessionId],
  )
  useEffect(() => () => releaseStore(store), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { running } = snapshot
  const [sendError, setSendError] = useState<string | null>(null)
  const send = (text: string) => {
    setSendError(null)
    channel.command('session.send', { deviceId, sessionId, text }).catch((error: Error) => {
      setSendError(error.message)
    })
  }
  const markers = experiment.markers
  return (
    <Screen title={title ?? sessionId} testID="detail">
      {snapshot.error || sendError ? (
        <Text style={[styles.error, { color: c.err, backgroundColor: c.raised }]} numberOfLines={2}>
          {snapshot.error ?? sendError}
        </Text>
      ) : null}
      {experiment.keyboard === 'sticky' ? (
        // 对话区和输入区用同一个偏移跟着键盘平移，在 UI 线程上同一帧动，两者之间的距离一直不变；
        // 顶上移出去的那一截藏到标题栏后面（标题栏压在上面）
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.list}>
          <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
        </KeyboardStickyView>
      ) : (
        <View style={styles.list}>
          <Transcript store={store} bottomOffset={insets.bottom} markers={markers} />
        </View>
      )}
      <Composer bottomInset={insets.bottom} markers={markers} busy={running} onSend={send} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  error: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
})
