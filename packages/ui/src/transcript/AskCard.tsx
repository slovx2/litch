// 已答的异步问题在历史中留痕；未答问题统一在输入框上方作答。
import {
  type AgentMessageItem,
  type AskAnswers,
  type AskReply,
  distinctReplies,
  keys,
  type ToolCallItem,
} from '@litch/core'
import { memo } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { CompactRow } from './CompactRow.tsx'
import { type ItemRef, useItem } from './messages.tsx'
import { useToggle } from './state.ts'

const NO_ANSWERS: AskAnswers = {}
export const AskCard = memo(function AskCard(ref: ItemRef) {
  const t = useT()
  const [open, setOpen] = useToggle(`${ref.deviceId}:${ref.sessionId}`, `ask:${ref.itemId}`, false)
  const item = useItem<AgentMessageItem>(ref)
  const answers = useKey<AskAnswers>(keys.answers(ref.deviceId, ref.sessionId)) ?? NO_ANSWERS
  const answered = item?.questions?.filter((q) => answers[q.id] !== undefined) ?? []
  if (answered.length === 0) return null
  return (
    <section className="ask" data-card="ask" data-state="answered">
      <CompactRow
        source={`${t('ask.title')} · ${t('ask.answeredCount', { count: answered.length })}`}
        summary={answers[answered[0]?.id ?? '']}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {open
        ? answered.map((q) => (
            <div className="ask-q" key={q.id}>
              <div className="ask-text">{q.title}</div>
              <Answer text={answers[q.id] ?? ''} />
            </div>
          ))
        : null}
    </section>
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
 * 每题先列题目和明确的回答区，未选项折叠；没答的写“已跳过”。
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
              {question.options.some((_, at) => !question.picked.includes(at)) ? (
                <details className="ask-alternatives">
                  <summary>{t('ask.options')}</summary>
                  <ul className="ask-picks">
                    {question.options.map((option, at) =>
                      question.picked.includes(at) ? null : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 选项不会增删换位
                        <li key={at}>
                          <span className="tx">
                            <b>{option.label}</b>
                            {option.description ? <span>{option.description}</span> : null}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
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
