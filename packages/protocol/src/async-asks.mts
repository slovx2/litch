// 模型边干活边问的问题（codex 的 request_user_input_async）：协议里怎么来、答复怎么写、又怎么从用户消息里认回来。
// 问题是一条助手消息，带着 delivery: async 和 questions；工具当场就回了“收到”，模型不停下来等。
// 答复没有专门的协议方法，是一条普通的用户消息，正文是一段 <send_user_message_question_reply>，
// 里面是 JSON 数组，每题一项 { questionItemId, question, answer }。写法和官方客户端一样（开源 codex 的
// context-fragments/answered_question.rs、tui/async_question_reply.rs），codex 和官方客户端都认得出是哪道题答了。
import type { PendingItem } from './pending-asks.mjs'

export interface AskQuestion {
  id: string
  title: string
  options: string[]
}

/** 问问题的那个工具。题目标识里带着它 */
export const ASK_TOOL = 'request_user_input_async'

const HEAD = '<send_user_message_question_reply>'
const TAIL = '</send_user_message_question_reply>'

/** 一道题的标识：[工具名, 协议条目的标识, 第几题]，和官方客户端的 JSON.stringify 一个样 */
export const askQuestionId = (itemId: string, index: number): string =>
  JSON.stringify([ASK_TOOL, itemId, index])

/** 协议里的题目 → 显示用的。题目是空的不要；选项去掉空的，一个都不剩就当没有选项 */
export function projectQuestions(
  itemId: string,
  questions: readonly { title: string; options: string[] | null }[] | null | undefined,
): AskQuestion[] | undefined {
  const shown: AskQuestion[] = []
  ;(questions ?? []).forEach((question, index) => {
    if (typeof question?.title !== 'string' || !question.title.trim()) return
    const options = (question.options ?? []).filter(
      (option): option is string => typeof option === 'string' && option.trim() !== '',
    )
    shown.push({ id: askQuestionId(itemId, index), title: question.title, options })
  })
  return shown.length > 0 ? shown : undefined
}

/** 答复里的一题 */
export interface AskReply {
  questionItemId: string
  /** 题目原文 */
  question: string
  answer: string
}

/** 几道题的回答写成发出去的正文。字段的先后和官方桌面端一样 */
export function askReplyText(replies: AskReply[]): string {
  const body = replies.map(({ questionItemId, question, answer }) => ({
    questionItemId,
    question,
    answer,
  }))
  return `${HEAD}\n${JSON.stringify(body)}\n${TAIL}`
}

const isReply = (value: unknown): value is AskReply =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AskReply).questionItemId === 'string' &&
  typeof (value as AskReply).question === 'string' &&
  typeof (value as AskReply).answer === 'string'

/** 合并题的答复仍携带所有调用标识，但气泡里同一题、同一答案只展示一次。 */
export function distinctReplies(replies: readonly AskReply[]): AskReply[] {
  const seen = new Set<string>()
  return replies.filter((reply) => {
    const key = JSON.stringify([reply.question, reply.answer])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 用户消息整段就是一份答复的，拆出每一题；不是、或者格式坏了返回 null，照原文显示。
 * 和官方客户端一样，数组和单独一项都认，一项不对就整段不认
 */
export function parseAskReply(text: string): AskReply[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(HEAD) || !trimmed.endsWith(TAIL)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(HEAD.length, trimmed.length - TAIL.length))
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  if (list.length === 0 || !list.every(isReply)) return null
  return list.map(({ questionItemId, question, answer }) => ({ questionItemId, question, answer }))
}

/** 题目标识 → 答了什么。一个会话里收到过的答复都在里面，后答的盖掉先答的 */
export type AskAnswers = Record<string, string>

/** 一批条目里的答复，并进已有的那张表。没有新的返回原来那张 */
export function gatherAnswers(before: AskAnswers, items: Iterable<PendingItem>): AskAnswers {
  let next = before
  for (const item of items) {
    if (item.kind !== 'userMessage' || item.peer || (item.system && item.system.kind !== 'here'))
      continue
    for (const reply of parseAskReply(item.text ?? '') ?? []) {
      if (next[reply.questionItemId] === reply.answer) continue
      if (next === before) next = { ...before }
      next[reply.questionItemId] = reply.answer
    }
  }
  return next
}

/**
 * 一条带题的消息现在是什么样子：
 * - answered：每道题都已答；部分答复不会跳过剩下的问题；
 * - open：还有没答的题，会话能发消息；
 * - closed：会话只读。新回合不会改变问题的状态。
 */
export type AskState = 'open' | 'answered' | 'closed'

export function askState(
  questions: readonly AskQuestion[],
  answers: AskAnswers,
  live: boolean,
): AskState {
  if (questions.every((question) => answers[question.id] !== undefined)) return 'answered'
  return live ? 'open' : 'closed'
}
