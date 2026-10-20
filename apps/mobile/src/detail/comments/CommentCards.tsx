// 对话里带评论的用户消息：开头那段 <litch-comments> 画成一张张编号的评论卡片（引用淡一点、评论正常字），
// 打的字画在下面（cells.tsx 的 UserCell）。点卡片弹出全文（CommentPopup），能找到原文的可以滚过去。
import { type ParsedComment, type ParsedComments, parseComments } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Row } from '../../core/rows'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useComments } from './context'

/** 认过的用户消息按行对象记着：滑回来的行不用再认一遍 */
const parsed = new WeakMap<Row, ParsedComments | null>()

/** 用户消息的行带的评论。没带、认不出是 null（照原文显示） */
export function commentsOfRow(row: Extract<Row, { type: 'user' }>): ParsedComments | null {
  if (parsed.has(row)) return parsed.get(row) ?? null
  const found = row.text.startsWith('<litch-comments>') ? parseComments(row.text) : null
  parsed.set(row, found)
  return found
}

export function CommentCards({
  comments,
  turnId,
  onLongPress,
}: {
  comments: ParsedComment[]
  turnId: string
  /** 卡片在消息的气泡里，长按照样打开这一回合的菜单 */
  onLongPress(): void
}) {
  const { c, font } = useTheme()
  const t = useT()
  const hub = useComments()
  return (
    <View style={styles.cards}>
      {comments.map((comment) => (
        <Pressable
          key={comment.index}
          accessibilityRole="button"
          disabled={!hub}
          onPress={() => hub?.show({ comment, turnId })}
          onLongPress={onLongPress}
          testID={`comment-card-${comment.index}`}
          style={({ pressed }) => [
            styles.card,
            { borderLeftColor: c.line3, backgroundColor: pressed ? c.press : c.raised },
          ]}
        >
          <Text style={[styles.label, { color: c.ink3, fontFamily: font.mono }]}>
            {t('comment.ref', { n: comment.index })}
          </Text>
          <Text numberOfLines={3} style={[styles.quote, { color: c.ink2 }]}>
            {comment.quote}
          </Text>
          {comment.note ? (
            <Text numberOfLines={4} style={[styles.note, { color: c.ink }]}>
              {comment.note}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  cards: { gap: 6 },
  card: { borderLeftWidth: 2, paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
  label: { fontSize: 11 },
  quote: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 14, lineHeight: 20 },
})
