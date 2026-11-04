// 默认收起的卡片共用的样子（系统消息、子会话回报、别的会话发来的话、问题卡）：左边一道细线，
// 第一行是标记、来源、标题、小标签（手动运行、对方跳过确认，不另占一行）、末尾的 ▸/▾；
// 收着的时候下面一行是正文摘要（只占一行），点一下展开，
// 展开后摘要不再显示，内容（children）排在下面。同桌面的 CompactRow
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../ui/theme'

export function CompactRow({
  mark,
  markColor,
  source,
  title,
  tag,
  summary,
  open,
  onPress,
  fixed = false,
  testID,
  children,
}: {
  mark: string
  /** 标记的颜色，缺省是三级字色（还没答的问题用等待色） */
  markColor?: string
  source: string
  /** 标题：任务名、问题的题目这类，和来源排在同一行 */
  title?: string
  /** 标题后面的小标签和它的颜色，收着展开都显示 */
  tag?: { text: string; color: string }
  /** 正文摘要，收着的时候在第二行，只占一行 */
  summary?: string
  open: boolean
  onPress(): void
  /** 没有可展开的内容，或者一直展开：不画箭头，点了也没反应 */
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
        style={({ pressed }) => [styles.press, pressed ? { backgroundColor: c.press } : null]}
      >
        <View style={styles.line}>
          <Text style={[styles.mark, { color: markColor ?? c.ink3, fontFamily: font.mono }]}>
            {mark}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.source, size, { color: c.ink2 }, title ? styles.capped : styles.shrink]}
          >
            {source}
          </Text>
          {title ? (
            <Text numberOfLines={1} style={[styles.title, styles.shrink, size, { color: c.ink }]}>
              {title}
            </Text>
          ) : null}
          {tag ? (
            <Text
              numberOfLines={1}
              style={[styles.tag, { color: tag.color, fontSize: font.size.small }]}
            >
              {tag.text}
            </Text>
          ) : null}
          {fixed ? null : (
            <Text style={[size, styles.caret, { color: c.ink3 }]}>{open ? '▾' : '▸'}</Text>
          )}
        </View>
        {!open && summary ? (
          <Text numberOfLines={1} style={[styles.sum, size, { color: c.ink3 }]}>
            {summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? children : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2 },
  press: { paddingVertical: 6, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  mark: { fontSize: 12, width: 14 },
  source: { fontWeight: '500' },
  title: { fontWeight: '600' },
  capped: { flexShrink: 1, maxWidth: '45%' },
  shrink: { flexShrink: 1 },
  tag: { flexShrink: 0 },
  // 来源、标题只占自己的宽，箭头靠右
  caret: { marginLeft: 'auto' },
  sum: { paddingLeft: 20 },
})
