// 模型边干活边问的题（codex 的 request_user_input_async）：对话里的一张卡片，和用户答复的那条消息。
// 题目来自助手消息上的 questions；答复是一条普通的用户消息（projection/asks.mts 写、认），
// 回合还在跑时直接插进这个回合，不排队（和官方客户端一样）。
// 卡片的三种样子：还能答（选一个建议的回答，或者自己写）、答过了（每题答了什么）、过去了（只读）。
// 问用户的工具（AskUserQuestion 等）答完以后画成同一个样子的问答卡片（AskedCard）。
import {
  type AgentMessageItem,
  type AskAnswers,
  type AskQuestion,
  type AskReply,
  askReplyText,
  askState,
  keys,
  type SessionMeta,
  type ToolCallItem,
  type TurnView,
} from '@litch/core'
import { memo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { type ItemRef, useItem } from './messages.tsx'

const NO_ANSWERS: AskAnswers = {}

/** 一题现在填的：选了第几个建议的回答，自己写了什么（写了就以写的为准） */
interface Draft {
  pick: number | null
  text: string
}

const answerOf = (question: AskQuestion, draft: Draft | undefined): string =>
  draft?.text.trim() || (draft?.pick != null ? (question.options[draft.pick] ?? '') : '')

/** 这条消息在不在会话的最后一个回合里：在，才还能答 */
function useInLastTurn({ deviceId, sessionId, itemId }: ItemRef): boolean {
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const last = useKey<TurnView>(keys.turn(deviceId, sessionId, turnIds?.at(-1) ?? ''))
  return last?.itemIds.includes(itemId) ?? false
}

/** 带题的助手消息画成的卡片 */
export const AskCard = memo(function AskCard(ref: ItemRef) {
  const { deviceId, sessionId, itemId } = ref
  const t = useT()
  const { channel } = useServices()
  const item = useItem<AgentMessageItem>(ref)
  const answers = useKey<AskAnswers>(keys.answers(deviceId, sessionId)) ?? NO_ANSWERS
  const live = useKey<SessionMeta>(keys.session(deviceId, sessionId))?.live ?? false
  const inLastTurn = useInLastTurn(ref)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** 发出去了、对面还没收下（排在队列里，等这个回合结束） */
  const [queued, setQueued] = useState(false)
  const questions = item?.kind === 'agentMessage' ? item.questions : undefined
  if (!questions) return null
  const state = askState(questions, answers, inLastTurn, live)
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
      // 插进回合里的答复当场就在对话里了（卡片随之变成“已答”）；没插进去的排在队列里
      setQueued(true)
    } catch (error) {
      setFailure(whyNot(error, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="ask"
      data-card="ask"
      data-state={state}
      data-anchor={`i:${itemId}`}
      aria-label={t('ask.title')}
    >
      <div className="ask-head">
        <i className={state === 'open' ? 'st wait' : 'st'} />
        <span className="grow">{t('ask.title')}</span>
        <span className="ask-state">{t(`ask.state.${state}`)}</span>
      </div>
      {questions.map((question) => {
        const draft = drafts[question.id]
        const answer = answers[question.id]
        return (
          <div className="ask-q" key={question.id}>
            <div className="ask-text">{question.title}</div>
            {open ? (
              <>
                {question.options.length > 0 ? (
                  <div className="opts" role="radiogroup" aria-label={question.title}>
                    {question.options.map((option, index) => (
                      // biome-ignore lint/a11y/useSemanticElements: 和输入区的提问卡片一样的选项样子，原生单选框排不出来
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: 建议的回答不会增删换位
                        key={index}
                        type="button"
                        className="opt"
                        role="radio"
                        aria-checked={draft?.pick === index && !draft.text.trim()}
                        disabled={busy}
                        onClick={() =>
                          edit(question.id, {
                            pick: draft?.pick === index ? null : index,
                            text: '',
                          })
                        }
                      >
                        <span className="tx">
                          <b>{option}</b>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <input
                  className="req-input ask-input"
                  value={draft?.text ?? ''}
                  disabled={busy}
                  placeholder={t(question.options.length > 0 ? 'ask.other' : 'ask.reply')}
                  aria-label={t(question.options.length > 0 ? 'ask.other' : 'ask.reply')}
                  onChange={(event) => edit(question.id, { text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    void send()
                  }}
                />
              </>
            ) : state === 'answered' ? (
              <div className="ask-answer" data-skipped={answer === undefined}>
                {answer ?? t('ask.skipped')}
              </div>
            ) : question.options.length > 0 ? (
              <ul className="ask-options">
                {question.options.map((option, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                  <li key={index}>{option}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      })}
      {failure ? (
        <p className="ask-hint err" role="status">
          {failure}
        </p>
      ) : null}
      {state === 'open' && queued ? <p className="ask-hint">{t('ask.queued')}</p> : null}
      {open ? (
        <div className="ask-acts">
          <span className="grow ask-note">{t('ask.note')}</span>
          <button
            type="button"
            className="btn primary"
            disabled={busy || replies.length === 0}
            onClick={() => void send()}
          >
            {t('ask.send')}
          </button>
        </div>
      ) : null}
    </section>
  )
})

/** 用户消息整段是一份答复时，气泡里画成“题目 → 回答”，不露那一段标签和 JSON */
export function AskReplyBody({ replies }: { replies: AskReply[] }) {
  const t = useT()
  return (
    <div className="umsg-text ask-reply">
      <span className="ask-reply-kind">{t('ask.replied')}</span>
      {replies.map((reply) => (
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
