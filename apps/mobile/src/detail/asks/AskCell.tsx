// 模型边干活边问的题（codex 的 request_user_input_async）：对话里的问题卡片，和用户答复的那条消息。
// 和桌面端（packages/ui/src/transcript/AskCard.tsx）同一套规矩：题目来自助手消息上的 questions，
// 答复是一条普通的用户消息（核心的 projection/asks.mts 写、认），回合还在跑时直接插进这个回合。
// 带题的消息在行里照常是几块 Markdown（行的规矩不动）：第一块画成这张卡片，其余的块不画。
// 问用户的工具（AskUserQuestion 等）答完以后画成同一个样子的问答卡片（AskedCell，同桌面端的 AskedCard）。
import {
  type AskQuestion,
  type AskReply,
  askReplyText,
  askState,
  type ToolCallItem,
} from '@litch/core'
import { memo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'
import { useSessionStore } from '../proposals/hooks'

/** 一题现在填的：选了第几个建议的回答，自己写了什么（写了就以写的为准） */
interface Draft {
  pick: number | null
  text: string
}

const answerOf = (question: AskQuestion, draft: Draft | undefined): string =>
  draft?.text.trim() || (draft?.pick != null ? (question.options[draft.pick] ?? '') : '')

/** 这一块 Markdown 所在的消息带不带题。带题的消息由 AskCell 画 */
export function useAsks(itemId: string): readonly AskQuestion[] | undefined {
  const { deviceId, sessionId } = useTranscript()
  return useSessionStore(deviceId, sessionId).questionsOf(itemId)
}

/** 带题的助手消息画成的卡片。first 为假（同一条消息切出来的后面几块）时什么都不画 */
export const AskCell = memo(function AskCell({
  itemId,
  first,
  questions,
}: {
  itemId: string
  first: boolean
  questions: readonly AskQuestion[]
}) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const channel = useChannel()
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const answers = useSyncExternalStore(store.subscribeAnswers, store.getAnswers)
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** 发出去了、对面还没收下（排在队列里，等这个回合结束） */
  const [queued, setQueued] = useState(false)
  if (!first) return null
  const inLastTurn = meta?.lastTurn != null && store.turnOf(itemId) === meta.lastTurn.id
  const state = askState(questions, answers, inLastTurn, meta?.live ?? false)
  const open = state === 'open' && !queued
  const replies: AskReply[] = questions.flatMap((question) => {
    const answer = answerOf(question, drafts[question.id])
    return answer ? [{ questionItemId: question.id, question: question.title, answer }] : []
  })
  const edit = (id: string, next: Partial<Draft>) =>
    setDrafts((all) => ({ ...all, [id]: { pick: null, text: '', ...all[id], ...next } }))
  const send = async () => {
    if (!open || busy || replies.length === 0) return
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('session.send', {
        deviceId,
        sessionId,
        text: askReplyText(replies),
        now: true,
      })
      setQueued(true)
    } catch (error) {
      setFailure(whyNot(error, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View
      testID={`ask:${itemId}`}
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
          testID={`ask:${itemId}:state`}
          style={[
            styles.state,
            { color: state === 'open' ? c.wait : c.ink3, fontFamily: font.mono },
          ]}
        >
          {t(`ask.state.${state}`)}
        </Text>
      </View>
      {questions.map((question, at) => {
        const draft = drafts[question.id]
        const answer = answers[question.id]
        const hint = t(question.options.length > 0 ? 'ask.other' : 'ask.reply')
        return (
          <View
            key={question.id}
            style={[styles.question, at > 0 ? { borderTopColor: c.line1, ...styles.split } : null]}
          >
            <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
              {question.title}
            </Text>
            {open ? (
              <>
                {question.options.map((option, index) => {
                  const checked = draft?.pick === index && !draft.text.trim()
                  return (
                    <Pressable
                      // biome-ignore lint/suspicious/noArrayIndexKey: 建议的回答不会增删换位
                      key={index}
                      accessibilityRole="radio"
                      accessibilityState={{ checked, disabled: busy }}
                      disabled={busy}
                      testID={`ask:${itemId}:${at}:pick:${index}`}
                      onPress={() =>
                        edit(question.id, { pick: draft?.pick === index ? null : index, text: '' })
                      }
                      style={({ pressed }) => [
                        styles.option,
                        {
                          minHeight: theme.hit,
                          borderColor: checked ? c.line3 : c.line2,
                          borderRadius: theme.radius.m,
                          backgroundColor: checked ? c.selBg : pressed ? c.press : c.panel,
                        },
                      ]}
                    >
                      <Text style={{ color: checked ? c.selFg : c.ink, fontSize: 15 }}>
                        {checked ? '◉ ' : '○ '}
                        {option}
                      </Text>
                    </Pressable>
                  )
                })}
                <TextInput
                  value={draft?.text ?? ''}
                  onChangeText={(text) => edit(question.id, { text })}
                  placeholder={hint}
                  placeholderTextColor={c.ink3}
                  accessibilityLabel={hint}
                  editable={!busy}
                  onSubmitEditing={() => void send()}
                  submitBehavior="submit"
                  testID={`ask:${itemId}:${at}:text`}
                  style={[
                    styles.input,
                    {
                      color: c.ink,
                      borderColor: c.line2,
                      backgroundColor: c.panel,
                      borderRadius: theme.radius.m,
                      minHeight: theme.hit,
                    },
                  ]}
                />
              </>
            ) : state === 'answered' ? (
              <Text
                style={[
                  styles.answer,
                  {
                    color: answer === undefined ? c.ink3 : c.ink,
                    borderLeftColor: answer === undefined ? c.line2 : c.accent,
                  },
                ]}
              >
                {answer ?? t('ask.skipped')}
              </Text>
            ) : (
              question.options.map((option, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                <Text key={index} style={{ color: c.ink2, fontSize: font.size.meta + 1 }}>
                  · {option}
                </Text>
              ))
            )}
          </View>
        )
      })}
      {failure ? (
        <Text style={[styles.note, { color: c.err, fontSize: font.size.meta }]}>{failure}</Text>
      ) : null}
      {state === 'open' && queued ? (
        <Text style={[styles.note, { color: c.ink2, fontSize: font.size.meta }]}>
          {t('ask.queued')}
        </Text>
      ) : null}
      {open ? (
        <View style={styles.acts}>
          <Text style={[styles.hint, { color: c.ink3, fontSize: font.size.meta }]}>
            {t('ask.note')}
          </Text>
          <Button
            label={t('ask.send')}
            disabled={replies.length === 0}
            busy={busy}
            onPress={() => void send()}
            testID={`ask:${itemId}:send`}
          />
        </View>
      ) : null}
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
      {replies.map((reply) => (
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
