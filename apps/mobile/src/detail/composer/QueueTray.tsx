// 回合进行中发的消息先排在核心里，回合结束按顺序发。这里一条一行：现在就说（插进正在跑的回合，
// harness 会引导的话）、改一改（拿回输入框）、拿掉。排着的消息归核心管，这里只发命令、不自己记。
import type { QueuedMessage } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

function Mini({
  label,
  onPress,
  testID,
  muted,
}: {
  label: string
  onPress(): void
  testID: string
  muted?: boolean
}) {
  const { c } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.mini,
        { borderColor: c.line2, backgroundColor: pressed ? c.press : 'transparent' },
      ]}
    >
      <Text style={[styles.miniText, { color: muted ? c.ink3 : c.ink }]}>{label}</Text>
    </Pressable>
  )
}

export function QueueTray({
  queued,
  running,
  canSteer,
  steerImages,
  onSteer,
  onEdit,
  onRemove,
  onRefused,
}: {
  queued: QueuedMessage[]
  running: boolean
  /** 会不会引导（声明了不会、或者试过对面不认识，就没有“现在就说”） */
  canSteer: boolean
  /** 引导的时候带不带得了图片 */
  steerImages: boolean
  onSteer(message: QueuedMessage): void
  onEdit(message: QueuedMessage): void
  onRemove(message: QueuedMessage): void
  /** 带图的那条插不进去：说一句为什么 */
  onRefused(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  if (queued.length === 0) return null
  return (
    <View testID="queue" style={[styles.tray, { borderBottomColor: c.line1 }]}>
      <Text style={[styles.head, { color: c.ink3, fontFamily: theme.font.mono }]}>
        {t('composer.queued')}
      </Text>
      {queued.map((message, index) => {
        const stuck = !steerImages && message.images.length > 0
        const text = message.text || t('composer.imageCount', { n: message.images.length })
        return (
          <View key={message.id} style={styles.row} testID={`queue:${index}`}>
            <Text numberOfLines={2} style={[styles.text, { color: c.ink2 }]}>
              {message.images.length > 0 && message.text
                ? `${text}  [${t('composer.imageCount', { n: message.images.length })}]`
                : text}
            </Text>
            {running && canSteer ? (
              <Mini
                testID={`queue:${index}:steer`}
                label={t('composer.steer')}
                muted={stuck}
                onPress={() => (stuck ? onRefused() : onSteer(message))}
              />
            ) : null}
            <Mini
              testID={`queue:${index}:edit`}
              label={t('composer.editQueued')}
              onPress={() => onEdit(message)}
            />
            <Mini testID={`queue:${index}:remove`} label="✕" onPress={() => onRemove(message)} />
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  tray: { paddingHorizontal: 12, paddingBottom: 6, marginBottom: 6, borderBottomWidth: 1, gap: 4 },
  head: { fontSize: 11 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { flex: 1, fontSize: 13 },
  mini: { borderWidth: 1, paddingHorizontal: 8, height: 28, justifyContent: 'center' },
  miniText: { fontSize: 13 },
})
