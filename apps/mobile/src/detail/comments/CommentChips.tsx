// 输入框上面的评论片：每条一片，写着编号、引用的开头和评论的开头；点片打开对话框改评论、删掉、定位原文，
// 片上的 ✕ 直接删掉这一条。编号就是先后，删了一条后面的往前挪。
import type { CommentExtra } from '@litch/core'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { CommentEditor } from './CommentEditor'
import { useComments } from './context'
import { snippet } from './refs'

export function CommentChips({
  comments,
  onChange,
  testID,
}: {
  comments: CommentExtra[]
  onChange(list: CommentExtra[]): void
  testID: string
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const hub = useComments()
  const [editing, setEditing] = useState<number | null>(null)
  if (comments.length === 0) return null
  const current = editing === null ? undefined : comments[editing]
  const remove = (at: number) => onChange(comments.filter((_, index) => index !== at))
  const target = current ? { quote: current.quote, itemId: current.itemId } : null
  const located = hub && target ? hub.locate(target) !== null : false
  return (
    <>
      <ScrollView
        horizontal
        style={styles.strip}
        contentContainerStyle={styles.stripIn}
        keyboardShouldPersistTaps="handled"
      >
        {comments.map((comment, at) => (
          <Pressable
            // biome-ignore lint/suspicious/noArrayIndexKey: 评论按位置编号，片没有自己的状态
            key={at}
            accessibilityRole="button"
            testID={`${testID}-comment-${at + 1}`}
            onPress={() => setEditing(at)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: c.line2,
                backgroundColor: pressed ? c.press : c.raised,
                borderRadius: theme.radius.s,
              },
            ]}
          >
            <Text style={[styles.index, { color: c.ink, fontFamily: theme.font.mono }]}>
              {at + 1}
            </Text>
            <Text numberOfLines={1} style={[styles.text, { color: c.ink2 }]}>
              “{snippet(comment.quote, 14)}”
              {comment.note ? (
                <Text style={{ color: c.ink }}> {snippet(comment.note, 10)}</Text>
              ) : null}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('comment.chip.remove', { n: at + 1 })}
              testID={`${testID}-comment-remove-${at + 1}`}
              hitSlop={8}
              onPress={() => remove(at)}
              style={styles.x}
            >
              <Text style={{ color: c.ink3, fontSize: 12 }}>✕</Text>
            </Pressable>
          </Pressable>
        ))}
      </ScrollView>
      <CommentEditor
        visible={current !== undefined}
        index={editing === null ? null : editing + 1}
        quote={current?.quote ?? ''}
        note={current?.note ?? ''}
        onSubmit={(note) => {
          if (editing === null || !current) return
          onChange(comments.map((each, at) => (at === editing ? { ...each, note } : each)))
        }}
        onRemove={() => editing !== null && remove(editing)}
        onLocate={hub && target && located ? () => hub.jump(target) : undefined}
        onClose={() => setEditing(null)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0 },
  stripIn: { gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingLeft: 6,
    height: 30,
    maxWidth: 240,
  },
  index: { fontSize: 12, fontWeight: '700', marginRight: 6 },
  text: { fontSize: 12, flexShrink: 1 },
  x: { paddingHorizontal: 8, height: 30, justifyContent: 'center' },
})
