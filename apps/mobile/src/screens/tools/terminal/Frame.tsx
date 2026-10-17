// 终端页的外框。竖屏就是通用的 Screen；横屏时屏幕矮，键盘一弹起来通用标题栏（52 高）占掉的地方
// 够终端放好几行，所以换成一条矮的（32 高）：返回、名字和目录挤在一行、右边同样的几个按钮，左右让开安全区。
import { useNavigation } from '@react-navigation/native'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../../../ui/i18n'
import { type HeaderAction, Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'

export function Frame({
  title,
  subtitle,
  wire,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  wire?: string
  actions: HeaderAction[]
  children: ReactNode
}) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  if (width <= height) {
    return (
      <Screen title={title} subtitle={subtitle} wire={wire} actions={actions} testID="terminal">
        {children}
      </Screen>
    )
  }
  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: c.win,
          paddingTop: insets.top,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
      testID="terminal"
    >
      <View style={[styles.bar, { backgroundColor: c.panel, borderBottomColor: c.line1 }]}>
        {wire ? <View style={[styles.wire, { backgroundColor: wire }]} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('app.back')}
          testID="header:back"
          hitSlop={8}
          style={styles.back}
          onPress={() => navigation.goBack()}
        >
          <Text style={[styles.backText, { color: c.ink }]}>‹</Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: c.ink }]}>
          {title}
          {subtitle ? (
            <Text style={{ color: c.ink3, fontFamily: theme.font.mono, fontSize: 11 }}>
              {'  '}
              {subtitle}
            </Text>
          ) : null}
        </Text>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            testID={action.testID}
            disabled={action.disabled}
            hitSlop={8}
            style={styles.action}
            onPress={action.onPress}
          >
            <Text style={[styles.actionText, { color: action.disabled ? c.ink3 : c.accent }]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingRight: 8,
  },
  wire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  back: { width: 40, height: 32, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 24, lineHeight: 28, marginTop: -3 },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600' },
  action: { height: 32, paddingHorizontal: 10, justifyContent: 'center' },
  actionText: { fontSize: 14, fontWeight: '600' },
  body: { flex: 1 },
})
