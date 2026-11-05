// 页面外框：安全区、标题栏（返回、标题、副标题、右侧按钮）、页面底色。标题栏在首帧就是最终的样子（F1）：
// 标题从路由参数来，不等数据。各页面一律用它，别自己画标题栏。
// compact 是矮的一条（32 高，标题和副标题挤在一行，左右让开安全区）：横屏时屏幕矮，键盘一弹起来通用的 52 高太占地方。
import { useNavigation } from '@react-navigation/native'
import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePane } from '../../nav/pane'
import { useT } from '../i18n'
import { useTheme } from '../theme'
import { KeyboardDismissBar } from './KeyboardForm'

export interface HeaderAction {
  label: string
  onPress(): void
  /** 测试标识（Maestro、uiautomator 用） */
  testID?: string
  disabled?: boolean
  /** 读屏名称：label 只是个记号（⋯、⏱）时给 */
  accessibilityLabel?: string
  /** 菜单内有需要用户处理的更新，读屏说明由调用方提供。 */
  attention?: boolean
}

/** 副标题前半段的链接（工作线的“↰ 经理名”）：整块标题都可点，点击区不小于标题栏高度，不另占一行 */
export interface HeaderLink {
  label: string
  onPress(): void
  accessibilityLabel: string
  testID?: string
}

export function Screen({
  title,
  subtitle,
  subtitleLink,
  back = true,
  actions = [],
  trailing,
  wire,
  compact = false,
  children,
  testID,
}: {
  title: string
  subtitle?: string | undefined
  subtitleLink?: HeaderLink | undefined
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
  const pane = usePane()
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const t = useT()
  const navigation = useNavigation()
  const { c } = theme
  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: c.win, // iPadOS 窗口化时状态栏不占 inset，但左上角窗口控件仍覆盖内容。
          paddingTop: Platform.OS === 'ios' && Platform.isPad && insets.top === 0 ? 28 : insets.top,
        },
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
            testID={pane?.split ? `header:back:${pane.pane}` : 'header:back'}
            hitSlop={8}
            style={compact ? styles.sideCompact : styles.side}
            onPress={() => {
              if (pane?.split && pane.pane === 'navigation') navigation.navigate('Devices' as never)
              else if (pane?.split) pane.back()
              else navigation.goBack()
            }}
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
          <Pressable
            disabled={!subtitleLink}
            {...(subtitleLink
              ? {
                  accessibilityRole: 'link' as const,
                  accessibilityLabel: `${title} · ${subtitleLink.accessibilityLabel}`,
                  testID: subtitleLink.testID,
                  onPress: subtitleLink.onPress,
                }
              : {})}
            style={({ pressed }) => [
              styles.titles,
              subtitleLink ? styles.titlesLink : null,
              pressed ? { backgroundColor: c.press } : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.title,
                { color: c.ink, fontSize: theme.font.size.title, fontFamily: theme.font.ui },
              ]}
            >
              {title}
            </Text>
            {subtitle || subtitleLink ? (
              <Text
                numberOfLines={1}
                style={[
                  styles.subtitle,
                  { color: c.ink3, fontSize: theme.font.size.small, fontFamily: theme.font.mono },
                ]}
              >
                {subtitleLink ? (
                  <Text style={{ color: c.accent }}>{subtitleLink.label}</Text>
                ) : null}
                {subtitleLink && subtitle ? ' · ' : ''}
                {subtitle}
              </Text>
            ) : null}
          </Pressable>
        )}
        {trailing}
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            {...(action.accessibilityLabel
              ? { accessibilityLabel: action.accessibilityLabel }
              : {})}
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
            {action.attention ? (
              <View
                testID={`${action.testID}:attention`}
                pointerEvents="none"
                style={[
                  styles.attention,
                  { backgroundColor: c.wait, borderRadius: theme.radius.s },
                ]}
              />
            ) : null}
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>{children}</View>
      {!pane || (pane.visible && pane.pane !== 'navigation') ? <KeyboardDismissBar /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  attention: { position: 'absolute', width: 7, height: 7, top: 7, right: 5 },
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
  titlesLink: { alignSelf: 'stretch', justifyContent: 'center' },
  title: { fontWeight: '600' },
  subtitle: { marginTop: 1 },
  action: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  actionText: { fontSize: 15, fontWeight: '600' },
  body: { flex: 1 },
})
