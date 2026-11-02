import { Pressable, StyleSheet, View } from 'react-native'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'
import { useTranscript } from './context'

/**
 * 复制整条消息的小图标（两个叠着的方框）。用户消息和回答的复制在长按菜单里；这里只给没有长按菜单的
 * 展开行（别的会话发来的消息、系统消息）用。手机没有悬停，所以常显，但只占一个小图标的位置
 */
export function MessageCopy({ itemId }: { itemId: string }) {
  const t = useT()
  const { c } = useTheme()
  const { copyMessage } = useTranscript()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('message.copy')}
      testID={`message-copy:${itemId}`}
      // 图标 28 见方，四边放 8：可点 44
      hitSlop={8}
      onPress={() => copyMessage(itemId)}
      style={({ pressed }) => [styles.button, pressed ? { backgroundColor: c.press } : null]}
    >
      {/* 后面那张只画上、左两条边，正好不碰前面那张，不用填底色 */}
      <View style={[styles.back, { borderColor: c.ink3 }]} />
      <View style={[styles.front, { borderColor: c.ink3 }]} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { alignSelf: 'flex-start', width: 28, height: 28 },
  back: {
    position: 'absolute',
    left: 7,
    top: 6,
    width: 10,
    height: 12,
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
  },
  front: { position: 'absolute', left: 11, top: 10, width: 10, height: 12, borderWidth: 1.5 },
})
