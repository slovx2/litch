// 对话里的问题卡（AskSheet）：问题和答案在同一张卡里，状态跟着变；作答统一在输入框上方的待答区。
// 问用户的工具（AskUserQuestion 等）答完画成问答卡片（AskedCard）。
import {
  type AgentMessageItem,
  type AskAnswers,
  type AskReply,
  distinctReplies,
  keys,
  type PendingQuestion,
  type ToolCallItem,
} from '@litch/core'
import { memo } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { CompactRow } from './CompactRow.tsx'
import { type ItemRef, useItem } from './messages.tsx'
import { useToggle } from './state.ts'

const NO_ANSWERS: AskAnswers = {}
const NO_PENDING: PendingQuestion[] = []

/** 问题卡里的一道题：标识、题目、建议的回答（只读，作答在输入框上方的待答区） */
export interface SheetQuestion {
  id: string
  title: string
  options: readonly string[]
}

/**
 * 问题卡：模型边干活边问的题（AskCard）和收尾留的问题（tree/TurnTail.tsx）都画成它，答案并在同一张卡里，
 * 不再另出一个“已回答问题”的气泡（messages.tsx 认出答复就不画）。卡片跟着状态变：
 * 待回答——一直展开，列题目和建议的回答；已答——默认收起，标题行写答了几题和题目，下面一行是答案，点开看每题；
 * 未回答（问题已经过去了）——收起，点开看题目和当时的选项。
 */
export function AskSheet({
  deviceId,
  sessionId,
  toggleId,
  anchor,
  questions,
}: {
  deviceId: string
  sessionId: string
  /** 展开状态记在对话区里用的标识 */
  toggleId: string
  anchor?: string | undefined
  questions: readonly SheetQuestion[]
}) {
  const t = useT()
  const [toggled, setToggled] = useToggle(`${deviceId}:${sessionId}`, toggleId, false)
  const answers = useKey<AskAnswers>(keys.answers(deviceId, sessionId)) ?? NO_ANSWERS
  const pending =
    useKey<PendingQuestion[]>(keys.pendingQuestions(deviceId, sessionId)) ?? NO_PENDING
  const answered = questions.filter((q) => answers[q.id] !== undefined)
  const waiting = pending.some((entry) => questions.some((q) => entry.replyIds.includes(q.id)))
  const state = answered.length === questions.length ? 'answered' : waiting ? 'open' : 'closed'
  const open = state === 'open' || toggled
  const first = questions[0]
  if (!first) return null
  return (
    <section className="ask" data-card="ask" data-state={state} data-anchor={anchor}>
      <CompactRow
        icon={state === 'open' ? <i className="st wait" /> : undefined}
        source={`${t('ask.title')} · ${
          state === 'answered'
            ? t('ask.answeredCount', { count: answered.length })
            : t(`ask.state.${state}`)
        }`}
        title={open ? undefined : first.title}
        summary={answered.map((q) => answers[q.id]).join(' · ')}
        open={open}
        onToggle={() => setToggled(!toggled)}
        fixed={state === 'open'}
      />
      {open
        ? questions.map((q) => {
            const answer = answers[q.id]
            return (
              <div className="ask-q" key={q.id}>
                <div className="ask-text">{q.title}</div>
                {answer !== undefined ? (
                  <Answer text={answer} />
                ) : q.options.length > 0 ? (
                  <div className="ask-chips">
                    {q.options.map((option, at) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 建议的回答不会增删换位
                      <span key={at}>{option}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })
        : null}
    </section>
  )
}

/** 建议的回答，一行一个，只读 */
function Picks({
  options,
}: {
  options: readonly { label: string; description?: string | null }[]
}) {
  return (
    <ul className="ask-picks">
      {options.map((option, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 选项不会增删换位
        <li key={at}>
          <span className="tx">
            <b>{option.label}</b>
            {option.description ? <span>{option.description}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** 模型边干活边问的题（带题的助手消息） */
export const AskCard = memo(function AskCard(ref: ItemRef) {
  const item = useItem<AgentMessageItem>(ref)
  const questions = item?.kind === 'agentMessage' ? item.questions : undefined
  if (!questions?.length) return null
  return (
    <AskSheet
      deviceId={ref.deviceId}
      sessionId={ref.sessionId}
      toggleId={`ask:${ref.itemId}`}
      anchor={`i:${ref.itemId}`}
      questions={questions}
    />
  )
})

/** 用户消息整段是一份答复时，气泡里画成“题目 → 回答”，不露那一段标签和 JSON */
export function AskReplyBody({ replies }: { replies: AskReply[] }) {
  const t = useT()
  return (
    <div className="umsg-text ask-reply">
      <span className="ask-reply-kind">{t('ask.replied')}</span>
      {distinctReplies(replies).map((reply) => (
        <div className="ask-reply-one" key={reply.questionItemId}>
          <div className="ask-reply-q">{reply.question}</div>
          <div className="ask-reply-a">{reply.answer}</div>
        </div>
      ))}
    </div>
  )
}

/** 问用户的工具卡片现在怎样：问着、答过了、没问成（失败、被拒、被打断） */
function askedState(item: ToolCallItem): 'open' | 'answered' | 'closed' {
  if (item.status === 'inProgress') return 'open'
  return item.status === 'completed' ? 'answered' : 'closed'
}

/**
 * 问用户的工具（AskUserQuestion 等，核心的 ToolCallItem.asked）画成的问答卡片，和上面答过的问题卡片一个样子：
 * 每题先列题目和明确的回答区，未选项折叠；没答的写“已跳过”。还在问的列题目和选项（作答在输入区的提问卡片上）。
 * 问的时候在输入区的请求卡片上答，这里只读。结果对不上题目的，题目下面是原始回答
 */
export const AskedCard = memo(function AskedCard({
  item,
  deviceId,
  sessionId,
}: {
  item: ToolCallItem
  deviceId: string
  sessionId: string
}) {
  const t = useT()
  const [open, setOpen] = useToggle(`${deviceId}:${sessionId}`, `asked:${item.id}`, false)
  const asked = item.asked
  if (!asked) return null
  const state = askedState(item)
  return (
    <section
      className="ask"
      data-card="asked"
      data-state={state}
      data-anchor={`i:${item.id}`}
      aria-label={t('ask.title')}
    >
      <CompactRow
        icon={state === 'open' ? <i className="st wait" /> : undefined}
        source={`${t('ask.title')} · ${
          state === 'answered'
            ? t('ask.answeredCount', {
                count: asked.questions.filter((q) => q.answer !== null).length,
              })
            : t(`ask.state.${state}`)
        }`}
        title={state !== 'answered' || open ? undefined : asked.questions[0]?.question}
        summary={asked.questions[0]?.answer ?? asked.raw}
        open={state !== 'answered' || open}
        onToggle={() => setOpen(!open)}
        fixed={state !== 'answered'}
      />
      {state !== 'answered' || open ? (
        <>
          {asked.questions.map((question, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 题目不会增删换位
            <div className="ask-q" key={index}>
              {question.header ? <div className="ask-kicker">{question.header}</div> : null}
              <div className="ask-text">{question.question}</div>
              {question.answer !== null ? (
                <Answer text={question.answer} />
              ) : state === 'answered' && asked.raw === null ? (
                <div className="ask-answer" data-skipped="true">
                  {t('ask.skipped')}
                </div>
              ) : null}
              {state === 'open' ? (
                <Picks options={question.options} />
              ) : question.options.some((_, at) => !question.picked.includes(at)) ? (
                <details className="ask-alternatives">
                  <summary>
                    {t(question.answer === null ? 'ask.optionsAll' : 'ask.options')}
                  </summary>
                  <Picks
                    options={question.options.filter((_, at) => !question.picked.includes(at))}
                  />
                </details>
              ) : null}
            </div>
          ))}
          {asked.raw !== null ? (
            <div className="ask-q">
              <div className="ask-answer" data-skipped={state !== 'answered'}>
                {asked.raw}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
})

/** 选择项与自由文字使用相同的回答样式，保留多行。 */
function Answer({ text }: { text: string }) {
  const t = useT()
  return (
    <div className="ask-answer">
      <span className="ask-answer-label">{t('ask.answer')}</span>
      <div>{text}</div>
    </div>
  )
}
