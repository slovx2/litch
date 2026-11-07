// 网页没有原生输入框编号；焦点与键盘出现后的滚动交给浏览器，仍按卡片视口限制多行框高度。
import { createContext, useContext, useState } from 'react'
import {
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  TextInput,
  type TextInputProps,
} from 'react-native'
import { cardInputMaxHeight } from '../ui/kit/card-input-layout'

const CardHeight = createContext(Number.POSITIVE_INFINITY)

export function CardTextInput({ style, ...props }: TextInputProps) {
  const height = useContext(CardHeight)
  const flat = StyleSheet.flatten(style)
  return (
    <TextInput
      {...props}
      style={[
        style,
        {
          maxHeight: cardInputMaxHeight(
            height,
            typeof flat?.maxHeight === 'number' ? flat.maxHeight : 160,
            typeof flat?.minHeight === 'number' ? flat.minHeight : 44,
          ),
        },
      ]}
    />
  )
}

export function KeyboardCardScrollView({
  children,
  onLayout,
  trackInputs: _trackInputs,
  ...props
}: ScrollViewProps & { trackInputs?: boolean }) {
  const [height, setHeight] = useState(Number.POSITIVE_INFINITY)
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEventThrottle={16}
      {...props}
      onLayout={(event) => {
        setHeight(event.nativeEvent.layout.height)
        onLayout?.(event)
      }}
    >
      <CardHeight.Provider value={height}>{children}</CardHeight.Provider>
    </ScrollView>
  )
}
