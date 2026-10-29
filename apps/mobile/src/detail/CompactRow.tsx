// 默认收成一行的卡片共用的样子（系统消息、子会话回报、别的会话发来的话）：左边一道细线，
// 一行是标记、来源、摘要（截断）、末尾的 ▸/▾，点一下展开；展开后摘要不再显示，内容（children）排在下面。同桌面的 CompactRow
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../ui/theme'

export function CompactRow({
  mark,
  source,
  summary,
  open,
  onPress,
  fixed = false,
  testID,
  children,
}: {
  mark: string
  source: string
  summary?: string
  open: boolean
  onPress(): void
  /** 没有可展开的内容：不画箭头，点了也没反应 */
  fixed?: boolean
  testID?: string
  children?: ReactNode
}) {
  const { c, font } = useTheme()
  const size = { fontSize: font.size.meta }
  return (
    <View testID={testID} style={[styles.bar, { borderLeftColor: c.line2 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={fixed ? undefined : { expanded: open }}
        disabled={fixed}
        onPress={onPress}
        style={({ pressed }) => [styles.line, pressed ? { backgroundColor: c.press } : null]}
      >
        <Text style={[styles.mark, { color: c.ink3, fontFamily: font.mono }]}>{mark}</Text>
        <Text
          numberOfLines={1}
          style={[
            styles.source,
            size,
            { color: c.ink2 },
            open || !summary ? styles.grow : styles.capped,
          ]}
        >
          {source}
        </Text>
        {!open && summary ? (
          <Text numberOfLines={1} style={[styles.grow, size, { color: c.ink3 }]}>
            {summary}
          </Text>
        ) : null}
        {fixed ? null : <Text style={[size, { color: c.ink3 }]}>{open ? '▾' : '▸'}</Text>}
      </Pressable>
      {open ? children : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  mark: { fontSize: 12 },
  source: { fontWeight: '500' },
  capped: { flexShrink: 1, maxWidth: '45%' },
  grow: { flex: 1 },
})
