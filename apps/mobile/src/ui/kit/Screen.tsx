// 页面外框：安全区、标题栏（返回、标题、副标题、右侧按钮）、页面底色。标题栏在首帧就是最终的样子（F1）：
// 标题从路由参数来，不等数据。各页面一律用它，别自己画标题栏。
// compact 是矮的一条（32 高，标题和副标题挤在一行，左右让开安全区）：横屏时屏幕矮，键盘一弹起来通用的 52 高太占地方。
import { useNavigation } from '@react-navigation/native'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../i18n'
import { useTheme } from '../theme'

export interface HeaderAction {
  label: string
  onPress(): void
  /** 测试标识（Maestro、uiautomator 用） */
  testID?: string
  disabled?: boolean
}

export function Screen({
  title,
  subtitle,
  back = true,
  actions = [],
  trailing,
  wire,
  compact = false,
  children,
  testID,
}: {
  title: string
  subtitle?: string
  /** 左上角返回。首页不要 */
  back?: boolean
  actions?: HeaderAction[]
  /** 标题栏尾部的自定义状态和控件。 */
  trailing?: ReactNode
  /** 设备的线色：标题栏左边一道竖线（设计稿里每台设备一根线色贯穿各处） */
  wire?: string
  /** 矮标题栏（横屏用） */
  compact?: boolean
  children: ReactNode
  testID?: string
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const t = useT()
  const navigation = useNavigation()
  const { c } = theme
  return (
    <View
      style={[
        styles.screen,
        { backgroundColor: c.win, paddingTop: insets.top },
        compact ? { paddingLeft: insets.left, paddingRight: insets.right } : null,
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.header,
          compact ? styles.headerCompact : null,
          { borderBottomColor: c.line1, backgroundColor: c.panel },
        ]}
      >
        {wire ? <View style={[styles.wire, { backgroundColor: wire }]} /> : null}
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('app.back')}
            testID="header:back"
            hitSlop={8}
            style={compact ? styles.sideCompact : styles.side}
            onPress={() => navigation.goBack()}
          >
            <Text style={[compact ? styles.backTextCompact : styles.backText, { color: c.ink }]}>
              ‹
            </Text>
          </Pressable>
        ) : (
          <View style={styles.pad} />
        )}
        {compact ? (
          <Text numberOfLines={1} style={[styles.titles, styles.titleCompact, { color: c.ink }]}>
            {title}
            {subtitle ? (
              <Text style={{ color: c.ink3, fontFamily: theme.font.mono, fontSize: 11 }}>
                {'  '}
                {subtitle}
              </Text>
            ) : null}
          </Text>
        ) : (
          <View style={styles.titles}>
            <Text
              numberOfLines={1}
              style={[
                styles.title,
                { color: c.ink, fontSize: theme.font.size.title, fontFamily: theme.font.ui },
              ]}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text
                numberOfLines={1}
                style={[
                  styles.subtitle,
                  { color: c.ink3, fontSize: theme.font.size.small, fontFamily: theme.font.mono },
                ]}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
        )}
        {trailing}
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            testID={action.testID}
            disabled={action.disabled}
            hitSlop={8}
            style={compact ? styles.actionCompact : styles.action}
            onPress={action.onPress}
          >
            <Text
              style={[
                styles.actionText,
                compact ? styles.actionTextCompact : null,
                { color: action.disabled ? c.ink3 : c.accent },
              ]}
            >
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
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingRight: 8,
    zIndex: 1,
  },
  wire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  headerCompact: { height: 32 },
  side: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sideCompact: { width: 40, height: 32, alignItems: 'center', justifyContent: 'center' },
  backTextCompact: { fontSize: 24, lineHeight: 28, marginTop: -3 },
  titleCompact: { fontSize: 14, fontWeight: '600' },
  actionCompact: { height: 32, paddingHorizontal: 10, justifyContent: 'center' },
  actionTextCompact: { fontSize: 14 },
  pad: { width: 16 },
  backText: { fontSize: 30, lineHeight: 34, marginTop: -4 },
  titles: { flex: 1, minWidth: 0 },
  title: { fontWeight: '600' },
  subtitle: { marginTop: 1 },
  action: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  actionText: { fontSize: 15, fontWeight: '600' },
  body: { flex: 1 },
})
