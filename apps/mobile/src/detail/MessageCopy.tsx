import { Pressable, StyleSheet, Text } from 'react-native'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'
import { useTranscript } from './context'

/** 手机没有悬停，消息旁常显的文字小操作和现有“收起”等按钮保持一致。 */
export function MessageCopy({ itemId }: { itemId: string }) {
  const t = useT()
  const { c, font } = useTheme()
  const { copyMessage } = useTranscript()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('message.copy')}
      testID={`message-copy:${itemId}`}
      onPress={() => copyMessage(itemId)}
      style={({ pressed }) => [styles.button, pressed ? { backgroundColor: c.press } : null]}
    >
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('message.copy')}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
})
