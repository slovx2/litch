// 输入区。放在 KeyboardStickyView 里，键盘升起时在 UI 线程上跟着键盘动画走（调研报告 K1–K4）；
// 发送时不收键盘（K6）。上沿一条青色标记线给 measure/ 认。
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { colors } from './theme'

export const COMPOSER_HEIGHT = 64

export function Composer({
  bottomInset,
  markers,
  busy,
  onSend,
}: {
  bottomInset: number
  markers: boolean
  busy: boolean
  onSend(text: string): void
}) {
  const [text, setText] = useState('')
  const send = () => {
    const value = text.trim()
    if (!value) return
    setText('')
    onSend(value)
  }
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: bottomInset }}>
      <View style={[styles.bar, { paddingBottom: bottomInset }]}>
        {markers ? <View style={styles.mark} /> : null}
        <View style={styles.row}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="发消息"
            style={styles.input}
            testID="composer-input"
            onSubmitEditing={send}
            submitBehavior="submit"
          />
          <Pressable onPress={send} style={styles.send} testID="composer-send">
            <Text style={styles.sendText}>{busy ? '排队' : '发送'}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardStickyView>
  )
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  mark: { height: 2, backgroundColor: colors.markComposer },
  row: {
    height: COMPOSER_HEIGHT - 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  input: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 14,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    fontSize: 15,
    color: colors.text,
  },
  send: {
    paddingHorizontal: 14,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accent,
    justifyContent: 'center',
  },
  sendText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
})
