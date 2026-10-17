// 提问：一次请求里有几道题就一道一道地问，可以来回翻、可以跳过，答到一半的内容记着（question-drafts.ts）。
// 选项单选；题目允许的话最后一项是“其他”，点了自己填（保密的题用密码框）；没有选项的题只有输入框。
// 选了一个选项之后隔一小会儿自己到下一题；在最后一题上选完、每道题都有了说法就直接交。
// 跳过的题回给对面的是空答案。答案怎么核对、怎么组织由核心定（collectAnswers）。
import {
  collectAnswers,
  type QuestionEntry,
  type QuestionRequest,
  type QuestionState,
  questionState,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { Card, CardButton, type CardProps, useRespond, Why } from './Card'
import { loadQuestionDraft, type QuestionDraft, saveQuestionDraft } from './question-drafts'

/** 选了一个选项之后隔这么久自己前进：够看清选中了哪个，又不用再点一下 */
const ADVANCE_MS = 180

const STEP_MARK: Record<QuestionState, string> = { open: '○', answered: '●', skipped: '–' }

function Option({
  title,
  note,
  checked,
  disabled,
  onPress,
  testID,
}: {
  title: string
  note?: string
  checked: boolean
  disabled: boolean
  onPress(): void
  testID: string
}) {
  const theme = useTheme()
  const { c } = theme
  const ink = checked ? c.invFg : c.ink
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.option,
        {
          minHeight: theme.hit,
          borderColor: checked ? c.line3 : c.line2,
          backgroundColor: checked ? c.invBg : pressed ? c.press : c.panel,
        },
      ]}
    >
      <Text style={[styles.optionTitle, { color: ink }]}>
        {checked ? '◉ ' : '○ '}
        {title}
      </Text>
      {note ? (
        <Text style={[styles.optionNote, { color: checked ? c.invFg : c.ink2 }]}>{note}</Text>
      ) : null}
    </Pressable>
  )
}

export function QuestionCard(props: CardProps<QuestionRequest>) {
  const { request, waiting, deviceId, sessionId } = props
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { busy, error, respond } = useRespond(props)
  const [draft, setDraft] = useState<QuestionDraft>(
    () => loadQuestionDraft(deviceId, sessionId, request.id) ?? { page: 0, entries: {} },
  )
  /** 交卷时发现还没答的那道题排第几。说明留到它有了说法，或者人翻走了为止 */
  const [nagged, setNagged] = useState<number | null>(null)
  /** 最新的草稿：定时的前进到点时按它算，不按设下定时的那一刻算 */
  const latest = useRef(draft)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const questions = request.questions
  const count = questions.length
  const clamp = (index: number) => Math.min(Math.max(index, 0), Math.max(count - 1, 0))
  const page = clamp(draft.page)
  const question = questions[page]
  const entry = question ? draft.entries[question.id] : undefined
  const state = questionState(entry)
  const last = page >= count - 1
  const options = question?.options ?? []
  const writing = options.length === 0 || entry?.kind === 'other'

  const cancelAuto = () => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }
  // 卡片没了（离开页面、请求在别处答了）：到点的前进不能再执行，那会替人把卷交了
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const update = (next: QuestionDraft) => {
    latest.current = next
    saveQuestionDraft(deviceId, sessionId, request.id, next)
    setDraft(next)
  }
  const goto = (index: number) => {
    cancelAuto()
    setNagged(null)
    update({ ...latest.current, page: clamp(index) })
  }
  const put = (id: string, next: QuestionEntry) =>
    update({ ...latest.current, entries: { ...latest.current.entries, [id]: next } })

  /** 交卷。还有没答的：翻到第一道没答的题上说明一句，不交 */
  const submit = () => {
    cancelAuto()
    if (busy) return
    const result = collectAnswers(questions, latest.current.entries)
    if ('open' in result) {
      update({ ...latest.current, page: result.open })
      setNagged(result.open)
      return
    }
    setNagged(null)
    respond({ answers: result.answers })
  }
  const forward = () => {
    const at = clamp(latest.current.page)
    if (at < count - 1) goto(at + 1)
    else submit()
  }
  const pick = (label: string) => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'option', label })
    timer.current = setTimeout(() => {
      timer.current = null
      forward()
    }, ADVANCE_MS)
  }
  const pickOther = () => {
    if (busy || !question) return
    cancelAuto()
    const before = latest.current.entries[question.id]
    put(question.id, { kind: 'other', text: before?.kind === 'other' ? before.text : '' })
  }
  const type = (text: string) => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'other', text })
  }
  const skip = () => {
    if (busy || !question) return
    cancelAuto()
    put(question.id, { kind: 'skipped' })
    forward()
  }

  if (!question) return null
  const multi = count > 1
  return (
    <Card
      testID="request:question"
      title={question.header || t('request.question')}
      right={multi ? t('request.step', { index: page + 1, count }) : undefined}
      waiting={waiting}
      error={error}
      actions={
        <>
          {multi ? (
            <>
              <CardButton
                kind="ghost"
                testID="request:back"
                label={`‹ ${t('request.back')}`}
                disabled={busy || page === 0}
                onPress={() => goto(page - 1)}
              />
              <CardButton
                kind="ghost"
                testID="request:next"
                label={`${t('request.next')} ›`}
                disabled={busy || last}
                onPress={() => goto(page + 1)}
              />
            </>
          ) : null}
          <CardButton
            kind="ghost"
            testID="request:skip"
            label={t('request.skip')}
            disabled={busy}
            onPress={skip}
          />
          <CardButton
            kind="primary"
            testID="request:submit"
            label={t('request.submit')}
            disabled={busy}
            onPress={submit}
          />
        </>
      }
    >
      {multi ? (
        <View style={styles.steps}>
          {questions.map((each, index) => {
            const mark = questionState(draft.entries[each.id])
            return (
              <Pressable
                key={each.id}
                accessibilityRole="button"
                accessibilityLabel={t(
                  mark === 'open'
                    ? 'request.stepOpen'
                    : mark === 'answered'
                      ? 'request.stepAnswered'
                      : 'request.stepSkipped',
                  { index: index + 1 },
                )}
                testID={`request:step:${index}`}
                disabled={busy}
                onPress={() => goto(index)}
                style={[
                  styles.step,
                  {
                    borderColor: index === page ? c.line3 : c.line1,
                    backgroundColor: index === page ? c.invBg : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{
                    color: index === page ? c.invFg : c.ink2,
                    fontFamily: theme.font.mono,
                    fontSize: 12,
                  }}
                >
                  {index + 1}
                  {STEP_MARK[mark]}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
      <Text style={[styles.question, { color: c.ink }]}>{question.question}</Text>
      {options.map((option, index) => (
        <Option
          // biome-ignore lint/suspicious/noArrayIndexKey: 对面给的标签可能重复，一道题的选项不会增删换位
          key={index}
          testID={`request:pick:${index}`}
          title={option.label}
          note={option.description}
          checked={entry?.kind === 'option' && entry.label === option.label}
          disabled={busy}
          onPress={() => pick(option.label)}
        />
      ))}
      {question.allowOther && options.length > 0 ? (
        <Option
          testID="request:pick:other"
          title={t('request.other')}
          checked={entry?.kind === 'other'}
          disabled={busy}
          onPress={pickOther}
        />
      ) : null}
      {writing ? (
        <TextInput
          key={question.id}
          autoFocus={options.length > 0}
          value={entry?.kind === 'other' ? entry.text : ''}
          onChangeText={type}
          placeholder={t('request.otherPlaceholder')}
          placeholderTextColor={c.ink3}
          secureTextEntry={question.secret}
          autoCapitalize="none"
          autoCorrect={!question.secret}
          editable={!busy}
          accessibilityLabel={question.header || question.question}
          onSubmitEditing={forward}
          submitBehavior="submit"
          testID="request:other"
          style={[
            styles.input,
            { color: c.ink, borderColor: c.line2, backgroundColor: c.panel, minHeight: theme.hit },
          ]}
        />
      ) : null}
      {state === 'skipped' ? <Why>{t('request.skippedNote')}</Why> : null}
      {nagged === page && state === 'open' ? (
        <Why tone="err">
          {multi ? t('request.unanswered', { index: page + 1 }) : t('request.unansweredOne')}
        </Why>
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  step: { borderWidth: 1, paddingHorizontal: 8, height: 28, justifyContent: 'center' },
  question: { fontSize: 15, lineHeight: 21 },
  option: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center' },
  optionTitle: { fontSize: 15 },
  optionNote: { fontSize: 13, marginTop: 2 },
  input: { borderWidth: 1, paddingHorizontal: 10, fontSize: 15 },
})
