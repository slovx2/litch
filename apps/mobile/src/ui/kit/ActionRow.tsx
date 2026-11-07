import type { ReactNode } from 'react'
import {
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native'

/** Web 的行尾操作与主按钮并列，避免 button 嵌套；原生保留原来的 Pressable 树。 */
export function ActionRow({
  children,
  action,
  actionGap,
  containerStyle,
  actionStyle,
  style,
  ...props
}: Omit<PressableProps, 'children'> & {
  children: ReactNode
  action?: ReactNode
  actionGap: number
  containerStyle: StyleProp<ViewStyle>
  actionStyle?: StyleProp<ViewStyle>
}) {
  if (Platform.OS !== 'web' || !action)
    return (
      <Pressable {...props} style={style}>
        {children}
        {action}
      </Pressable>
    )
  return (
    <View style={[styles.container, containerStyle]}>
      <Pressable
        {...props}
        style={(state) => [
          typeof style === 'function' ? style(state) : style,
          styles.main,
          { paddingRight: actionGap },
        ]}
      >
        {children}
      </Pressable>
      <View style={actionStyle}>{action}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
})
