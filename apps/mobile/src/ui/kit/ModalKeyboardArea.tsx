// Modal 是独立原生窗口。和终端页一样使用 keyboard-controller，并测量窗口内的实际位置；
// 不依赖 Android Activity 的 adjustResize，也不叠加手算键盘高度。内层负责居中或贴底布局。
import type { ReactNode } from 'react'
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardArea, KeyboardDismissBar } from './KeyboardForm'

export function ModalKeyboardArea({
  children,
  style,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  return (
    <>
      <KeyboardArea style={{ paddingTop: insets.top }}>
        <View style={[styles.fill, style]} pointerEvents="box-none">
          {children}
        </View>
      </KeyboardArea>
      <KeyboardDismissBar />
    </>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
