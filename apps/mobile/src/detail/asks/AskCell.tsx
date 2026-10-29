// 已答题在历史中留痕，未答题统一在输入框上方作答。
import { type AskQuestion, type AskReply, distinctReplies, type ToolCallItem } from '@litch/core'
import { memo, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'
import { useSessionStore } from '../proposals/hooks'
export function useAsks(itemId: string): readonly AskQuestion[] | undefined {
  const { deviceId, sessionId } = useTranscript()
  return useSessionStore(deviceId, sessionId).questionsOf(itemId)
}
export const AskCell = memo(function AskCell({
  first,
  questions,
}: {
  itemId: string
  first: boolean
  questions: readonly AskQuestion[]
}) {
  const { c, font } = useTheme()
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const answers = useSyncExternalStore(store.subscribeAnswers, store.getAnswers)
  const answered = questions.filter((q) => answers[q.id] !== undefined)
  if (!first || answered.length === 0) return null
  return (
    <View style={styles.card}>
      {answered.map((q) => (
        <View key={q.id} style={styles.question}>
          <Text style={{ color: c.ink2, fontSize: font.size.body }}>{q.title}</Text>
          <Text style={{ color: c.ink, fontSize: font.size.body }}>{answers[q.id]}</Text>
        </View>
      ))}
    </View>
  )
})

/**
 * 问用户的工具画成的问答卡片（核心的 ToolCallItem.asked）：每题是题头、题目、选项（选中的打勾），自己写的回答引在下面，
 * 没答的写“已跳过”；结果对不上题目的，题目下面是原始回答。问的时候在请求卡片上答，这里只读
 */
export const AskedCell = memo(function AskedCell({ item }: { item: ToolCallItem }) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const asked = item.asked
  if (!asked) return null
  const state =
    item.status === 'inProgress' ? 'open' : item.status === 'completed' ? 'answered' : 'closed'
  const quote = (text: string, skipped: boolean) => (
    <Text
      style={[
        styles.answer,
        { color: skipped ? c.ink3 : c.ink, borderLeftColor: skipped ? c.line2 : c.accent },
      ]}
    >
      {text}
    </Text>
  )
  return (
    <View
      testID={`asked:${item.id}`}
      style={[
        styles.card,
        {
          borderColor: state === 'open' ? c.line3 : c.line2,
          backgroundColor: c.raised,
          borderRadius: theme.radius.l,
        },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.kind, { color: c.ink3, fontFamily: font.mono }]}>
          ? {t('ask.title')}
        </Text>
        <Text
          style={[
            styles.state,
            { color: state === 'open' ? c.wait : c.ink3, fontFamily: font.mono },
          ]}
        >
          {t(`ask.state.${state}`)}
        </Text>
      </View>
      {asked.questions.map((question, at) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: 题目不会增删换位
          key={at}
          style={[styles.question, at > 0 ? { borderTopColor: c.line1, ...styles.split } : null]}
        >
          {question.header ? (
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{question.header}</Text>
          ) : null}
          <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
            {question.question}
          </Text>
          {question.options.map((option, index) => {
            const picked = question.picked.includes(index)
            return (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                key={index}
                style={styles.pick}
                accessibilityLabel={picked ? `${t('ask.picked')} ${option.label}` : option.label}
              >
                <Text style={[styles.mark, { color: c.accent }]}>{picked ? '✓' : ''}</Text>
                <View style={styles.pickText}>
                  <Text style={{ color: picked ? c.ink : c.ink2, fontSize: font.size.body }}>
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </View>
            )
          })}
          {question.other !== null
            ? quote(question.other, false)
            : state === 'answered' && asked.raw === null && question.answer === null
              ? quote(t('ask.skipped'), true)
              : null}
        </View>
      ))}
      {asked.raw !== null ? (
        <View style={[styles.question, { borderTopColor: c.line1, ...styles.split }]}>
          {quote(asked.raw, state !== 'answered')}
        </View>
      ) : null}
    </View>
  )
})

/** 用户消息整段是一份答复时，气泡里画成“题目 → 回答”，不露那一段标签和 JSON */
export function AskReplyText({ replies }: { replies: AskReply[] }) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <View style={styles.reply} testID="ask-reply">
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('ask.replied')}</Text>
      {distinctReplies(replies).map((reply) => (
        <View key={reply.questionItemId} style={styles.replyOne}>
          <Text
            style={[
              styles.replyQuestion,
              { color: c.ink2, borderLeftColor: c.line2, fontSize: font.size.meta + 1 },
            ]}
          >
            {reply.question}
          </Text>
          <Text style={{ color: c.ink, fontSize: font.size.body }}>{reply.answer}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6, borderWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, paddingBottom: 0 },
  kind: { flex: 1, fontSize: 11 },
  state: { fontSize: 11 },
  question: { padding: 12, gap: 8 },
  split: { borderTopWidth: StyleSheet.hairlineWidth },
  title: { lineHeight: 21 },
  option: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 10, fontSize: 15 },
  answer: { borderLeftWidth: 2, paddingLeft: 10, fontSize: 15, lineHeight: 21 },
  pick: { flexDirection: 'row', gap: 8 },
  mark: { width: 14, fontSize: 15, lineHeight: 21 },
  pickText: { flex: 1, gap: 2 },
  note: { paddingHorizontal: 12, paddingBottom: 8, lineHeight: 19 },
  acts: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, paddingTop: 0 },
  hint: { flex: 1, lineHeight: 18 },
  reply: { gap: 6 },
  replyOne: { gap: 2 },
  replyQuestion: { borderLeftWidth: 2, paddingLeft: 8, lineHeight: 19 },
})
