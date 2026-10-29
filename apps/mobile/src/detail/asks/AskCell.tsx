// 已答题在历史中留痕，未答题统一在输入框上方作答。
import { type AskQuestion, type AskReply, distinctReplies, type ToolCallItem } from '@litch/core'
import { memo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'
import { useSessionStore } from '../proposals/hooks'
import { useCardOpen } from '../use-card-open'
export function useAsks(itemId: string): readonly AskQuestion[] | undefined {
  const { deviceId, sessionId } = useTranscript()
  return useSessionStore(deviceId, sessionId).questionsOf(itemId)
}
export const AskCell = memo(function AskCell({
  first,
  itemId,
  questions,
}: {
  itemId: string
  first: boolean
  questions: readonly AskQuestion[]
}) {
  const { c, font } = useTheme()
  const t = useT()
  const [open, toggle] = useCardOpen(`ask:${itemId}`)
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const answers = useSyncExternalStore(store.subscribeAnswers, store.getAnswers)
  const answered = questions.filter((q) => answers[q.id] !== undefined)
  if (!first || answered.length === 0) return null
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={styles.compactHead}
      >
        <Text numberOfLines={1} style={{ color: c.ink2, fontSize: font.size.meta }}>
          {open ? '⌄' : '›'} {t('ask.title')} · {t('ask.answeredCount', { count: answered.length })}{' '}
          · {answers[answered[0]?.id ?? '']}
        </Text>
      </Pressable>
      {open
        ? answered.map((q) => (
            <View key={q.id} style={styles.question}>
              <Text style={{ color: c.ink2, fontSize: font.size.body }}>{q.title}</Text>
              <Answer text={answers[q.id] ?? ''} />
            </View>
          ))
        : null}
    </View>
  )
})

/**
 * 问用户的工具画成的问答卡片（核心的 ToolCallItem.asked）：每题先列题目和回答区，其他选项折叠，
 * 没答的写“已跳过”；结果对不上题目的，题目下面是原始回答。问的时候在请求卡片上答，这里只读
 */
export const AskedCell = memo(function AskedCell({ item }: { item: ToolCallItem }) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [open, toggle] = useCardOpen(`asked:${item.id}`)
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
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: state !== 'answered' || open }}
        disabled={state !== 'answered'}
        onPress={toggle}
        style={styles.compactHead}
      >
        <Text numberOfLines={1} style={{ color: c.ink2, fontSize: font.size.meta }}>
          {state !== 'answered' || open ? '⌄' : '›'} {t('ask.title')} ·{' '}
          {state === 'answered'
            ? t('ask.answeredCount', {
                count: asked.questions.filter((q) => q.answer !== null).length,
              })
            : t(`ask.state.${state}`)}
          {!open && state === 'answered'
            ? ` · ${asked.questions[0]?.answer ?? asked.raw ?? ''}`
            : ''}
        </Text>
      </Pressable>
      {state !== 'answered' || open ? (
        <>
          {asked.questions.map((question, at) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: 题目不会增删换位
              key={at}
              style={[
                styles.question,
                at > 0 ? { borderTopColor: c.line2, ...styles.split } : null,
              ]}
            >
              {question.header ? (
                <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{question.header}</Text>
              ) : null}
              <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
                {question.question}
              </Text>
              {question.answer !== null ? (
                <Answer text={question.answer} />
              ) : state === 'answered' && asked.raw === null ? (
                quote(t('ask.skipped'), true)
              ) : null}
              {question.options.some((_, index) => !question.picked.includes(index)) ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !!expanded[at] }}
                    onPress={() => setExpanded((before) => ({ ...before, [at]: !before[at] }))}
                    style={{ minHeight: theme.hit, justifyContent: 'center' }}
                  >
                    <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
                      {expanded[at] ? '⌄ ' : '› '}
                      {t('ask.options')}
                    </Text>
                  </Pressable>
                  {expanded[at]
                    ? question.options.map((option, index) =>
                        question.picked.includes(index) ? null : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 选项不会增删换位
                          <View key={index} style={styles.pickText}>
                            <Text style={{ color: c.ink2, fontSize: font.size.body }}>
                              {option.label}
                            </Text>
                            {option.description ? (
                              <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
                                {option.description}
                              </Text>
                            ) : null}
                          </View>
                        ),
                      )
                    : null}
                </>
              ) : null}
            </View>
          ))}
          {asked.raw !== null ? (
            <View style={[styles.question, { borderTopColor: c.line2, ...styles.split }]}>
              {quote(asked.raw, state !== 'answered')}
            </View>
          ) : null}
        </>
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
  question: { padding: 8, gap: 4 },
  compactHead: { paddingHorizontal: 10, minHeight: 40, justifyContent: 'center' },
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

function Answer({ text }: { text: string }) {
  const { c, font, radius } = useTheme()
  const t = useT()
  return (
    <View
      style={{
        padding: 8,
        gap: 2,
        backgroundColor: c.selBg,
        borderColor: c.line3,
        borderWidth: 1,
        borderRadius: radius.m,
      }}
    >
      <Text style={{ color: c.selFg, fontSize: font.size.meta, fontWeight: '600' }}>
        {t('ask.answer')}
      </Text>
      <Text style={{ color: c.selFg, fontSize: font.size.meta + 1, lineHeight: 19 }}>{text}</Text>
    </View>
  )
}
