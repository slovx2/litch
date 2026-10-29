// 问用户的题画成一张卡，状态跟着变：还没答的一直展开，列题目和建议的回答（作答在输入框上方，这里只读）；
// 答完收起，标题行加一行答案摘要，点开看每题的回答。答复那条用户消息不再单独画（rows.ts 认出来跳过）。
// 模型边干活边问的题（AskCell）和收尾的问题（WrapAskCell）共用 AskSheet，同桌面的 AskSheet
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

/** 卡上的一道题：答复用的题目标识、题目、建议的回答 */
export interface SheetQuestion {
  id: string
  title: string
  options: readonly string[]
}

/**
 * 问题卡：还在待答集合里的（输入框上方那一块）算“待回答”，一直展开；都答了算“已答”，默认收起；
 * 都不是（回合过去了没人答）算“未回答”，收起，点开看题目
 */
export function AskSheet({
  cardId,
  testID,
  questions,
}: {
  cardId: string
  testID: string
  questions: readonly SheetQuestion[]
}) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const [opened, toggle] = useCardOpen(cardId)
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const answers = useSyncExternalStore(store.subscribeAnswers, store.getAnswers)
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const answered = questions.filter((q) => answers[q.id] !== undefined)
  const done = answered.length === questions.length
  const waiting =
    !done &&
    (meta?.pendingQuestions ?? []).some((p) => questions.some((q) => p.replyIds.includes(q.id)))
  const open = waiting || opened
  const source = `${t('ask.title')} · ${
    answered.length > 0
      ? t('ask.answeredCount', { count: answered.length })
      : t(waiting ? 'ask.state.open' : 'ask.state.closed')
  }`
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          borderColor: waiting ? c.line3 : c.line2,
          backgroundColor: c.raised,
          borderRadius: theme.radius.l,
        },
      ]}
    >
      <Head
        waiting={waiting}
        source={source}
        title={open ? undefined : questions[0]?.title}
        summary={answered.map((q) => answers[q.id]).join(' · ') || undefined}
        open={open}
        onPress={toggle}
        fixed={waiting}
      />
      {open
        ? questions.map((q) => {
            const answer = answers[q.id]
            return (
              <View
                key={q.id}
                style={[styles.question, { borderTopColor: c.line1, ...styles.split }]}
              >
                <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
                  {q.title}
                </Text>
                {answer !== undefined ? (
                  <Answer text={answer} />
                ) : q.options.length > 0 ? (
                  <View style={styles.chips}>
                    {q.options.map((option, at) => (
                      <Text
                        // biome-ignore lint/suspicious/noArrayIndexKey: 建议的回答不会增删换位
                        key={at}
                        style={[
                          styles.chip,
                          {
                            color: c.ink2,
                            borderColor: c.line2,
                            borderRadius: theme.radius.s,
                            fontSize: font.size.meta,
                          },
                        ]}
                      >
                        {option}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            )
          })
        : null}
    </View>
  )
}

/** 带题的助手消息（模型边干活边问）：同一条消息拆成几块时只在第一块画 */
export const AskCell = memo(function AskCell({
  first,
  itemId,
  questions,
}: {
  itemId: string
  first: boolean
  questions: readonly AskQuestion[]
}) {
  if (!first) return null
  return <AskSheet cardId={`ask:${itemId}`} testID={`ask:${itemId}`} questions={questions} />
})

/**
 * 问用户的工具画成的问答卡片（核心的 ToolCallItem.asked）：还在问的列出题目和选项（在请求卡片上答，这里只读）；
 * 答完收起，点开每题先列题目和回答区，其他选项折叠，没答的写“已跳过”；结果对不上题目的，题目下面是原始回答
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
      <Head
        waiting={state === 'open'}
        source={`${t('ask.title')} · ${
          state === 'answered'
            ? t('ask.answeredCount', {
                count: asked.questions.filter((q) => q.answer !== null).length,
              })
            : t(`ask.state.${state}`)
        }`}
        title={state === 'answered' && !open ? asked.questions[0]?.question : undefined}
        summary={asked.questions[0]?.answer ?? asked.raw ?? undefined}
        open={state !== 'answered' || open}
        onPress={toggle}
        fixed={state !== 'answered'}
      />
      {state !== 'answered' || open ? (
        <>
          {asked.questions.map((question, at) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: 题目不会增删换位
              key={at}
              style={[styles.question, { borderTopColor: c.line1, ...styles.split }]}
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
              {state === 'open'
                ? question.options.map((option, index) => (
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
                  ))
                : null}
              {state !== 'open' &&
              question.options.some((_, index) => !question.picked.includes(index)) ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !!expanded[at] }}
                    onPress={() => setExpanded((before) => ({ ...before, [at]: !before[at] }))}
                    style={{ minHeight: theme.hit, justifyContent: 'center' }}
                  >
                    <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
                      {expanded[at] ? '▾ ' : '▸ '}
                      {t(question.answer === null ? 'ask.optionsAll' : 'ask.options')}
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
            <View style={[styles.question, { borderTopColor: c.line1, ...styles.split }]}>
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

/**
 * 卡片顶上的标题行：还在问的前面一个等待记号，来源和状态、标题（收着时第一题的题目）、末尾 ▸/▾；
 * 收着的时候下面一行是答案摘要（只占一行）。同 CompactRow，还在问的一直展开、不画箭头
 */
function Head({
  source,
  title,
  summary,
  open,
  onPress,
  fixed = false,
  waiting = false,
}: {
  source: string
  title?: string | undefined
  summary?: string | undefined
  open: boolean
  onPress(): void
  fixed?: boolean
  waiting?: boolean
}) {
  const { c, font } = useTheme()
  const size = { fontSize: font.size.meta }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={fixed ? undefined : { expanded: open }}
      disabled={fixed}
      onPress={onPress}
      style={({ pressed }) => [styles.head, pressed ? { backgroundColor: c.press } : null]}
    >
      <View style={styles.headLine}>
        {waiting ? <Text style={[size, { color: c.wait }]}>◆</Text> : null}
        <Text
          numberOfLines={1}
          style={[styles.source, size, { color: c.ink2 }, title ? styles.capped : styles.grow]}
        >
          {source}
        </Text>
        {title ? (
          <Text numberOfLines={1} style={[styles.headTitle, styles.grow, size, { color: c.ink }]}>
            {title}
          </Text>
        ) : null}
        {fixed ? null : <Text style={[size, { color: c.ink3 }]}>{open ? '▾' : '▸'}</Text>}
      </View>
      {!open && summary ? (
        <Text numberOfLines={1} style={[size, { color: c.ink3 }]}>
          {summary}
        </Text>
      ) : null}
    </Pressable>
  )
}

/** 回答：左边一道强调色、淡淡的底，和题目分得开；选的和自己写的一个样子 */
function Answer({ text }: { text: string }) {
  const { c, font, radius } = useTheme()
  const t = useT()
  return (
    <View
      style={[
        styles.answerBox,
        {
          backgroundColor: c.sel,
          borderLeftColor: c.accent,
          borderTopRightRadius: radius.s,
          borderBottomRightRadius: radius.s,
        },
      ]}
    >
      <Text style={{ color: c.ink3, fontSize: font.size.small, fontWeight: '500' }}>
        {t('ask.answer')}
      </Text>
      <Text selectable style={{ color: c.ink, fontSize: font.size.meta + 1, lineHeight: 19 }}>
        {text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6, borderWidth: 1, overflow: 'hidden' },
  head: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  source: { fontWeight: '500' },
  headTitle: { fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 1, lineHeight: 18 },
  capped: { flexShrink: 1, maxWidth: '45%' },
  grow: { flex: 1 },
  question: { paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  split: { borderTopWidth: StyleSheet.hairlineWidth },
  title: { lineHeight: 21 },
  answer: { borderLeftWidth: 2, paddingLeft: 10, fontSize: 14, lineHeight: 19 },
  answerBox: { borderLeftWidth: 2, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
  pickText: { flex: 1, gap: 2 },
  reply: { gap: 6 },
  replyOne: { gap: 2 },
  replyQuestion: { borderLeftWidth: 2, paddingLeft: 8, lineHeight: 19 },
})
