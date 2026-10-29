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
import { type ItemRef, useItem } from './messages.tsx'

const NO_ANSWERS: AskAnswers = {}
export const AskCard = memo(function AskCard(ref: ItemRef) {
  const t = useT()
  const item = useItem<AgentMessageItem>(ref)
  const answers = useKey<AskAnswers>(keys.answers(ref.deviceId, ref.sessionId)) ?? NO_ANSWERS
  const answered = item?.questions?.filter((q) => answers[q.id] !== undefined) ?? []
  if (answered.length === 0) return null
  return (
    <section className="ask" data-card="ask" data-state="answered">
      <div className="ask-head">{t('ask.state.answered')}</div>
      {answered.map((q) => (
        <div className="ask-q" key={q.id}>
          <div className="ask-text">{q.title}</div>
          <div className="ask-answer">{answers[q.id]}</div>
        </div>
      ))}
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
 * 每题是题头、题目、选项（选中的打勾），自己写的回答引在下面；没答的写“已跳过”。
 * 问的时候在输入区的请求卡片上答，这里只读。结果对不上题目的，题目下面是原始回答
 */
export const AskedCard = memo(function AskedCard({ item }: { item: ToolCallItem }) {
  const t = useT()
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
      <div className="ask-head">
        <i className={state === 'open' ? 'st wait' : 'st'} />
        <span className="grow">{t('ask.title')}</span>
        <span className="ask-state">{t(`ask.state.${state}`)}</span>
      </div>
      {asked.questions.map((question, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 题目不会增删换位
        <div className="ask-q" key={index}>
          {question.header ? <div className="ask-kicker">{question.header}</div> : null}
          <div className="ask-text">{question.question}</div>
          {question.options.length > 0 ? (
            <ul className="ask-picks">
              {question.options.map((option, at) => {
                const picked = question.picked.includes(at)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                  <li key={at} data-picked={picked} title={picked ? t('ask.picked') : undefined}>
                    <span className="mark" aria-hidden="true">
                      {picked ? '✓' : ''}
                    </span>
                    <span className="tx">
                      <b>{option.label}</b>
                      {option.description ? <span>{option.description}</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {question.other !== null ? (
            <div className="ask-answer">{question.other}</div>
          ) : state === 'answered' && asked.raw === null && question.answer === null ? (
            <div className="ask-answer" data-skipped="true">
              {t('ask.skipped')}
            </div>
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
    </section>
  )
})
