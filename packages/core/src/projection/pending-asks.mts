// 待答问题属于会话，不属于最后一个回合。明确答复只了结对应题；用户直接发话算回答此前的题。
// 子会话回报、后台唤醒和空收尾不能把它们了结。

import type { SessionOp } from '../channel/protocol.mjs'
import type { ItemView, QueuedMessage, TurnView } from '../model.mjs'
import { type AskAnswers, askReplyText, gatherAnswers, parseAskReply } from './asks.mjs'
import { isUserReply } from './user-reply.mjs'

export interface PendingQuestion {
  kind: 'wrap' | 'async'
  id: string
  itemId: string
  turnId: string
  title: string
  options: { label: string; answer: string }[]
  /** 相同的未答问题只画一次，答复同时指向这些调用。 */
  replyIds: string[]
}

export const wrapQuestionId = (itemId: string): string => JSON.stringify(['wrap_up', itemId])

/** 常规工具进度、流式文字不影响待答集合，不必为它们重扫历史。删除/改写时看修改前的条目。 */
export function changesQuestions(
  op: SessionOp,
  itemOf: (id: string) => ItemView | undefined,
): boolean {
  const relevant = (item: ItemView | undefined) =>
    item?.kind === 'agentMessage'
      ? !!item.questions?.length
      : item?.kind === 'toolCall'
        ? !!item.wrapUp
        : item?.kind === 'userMessage'
  switch (op.op) {
    case 'turn.add':
    case 'turn.remove':
    case 'turn.status':
    case 'queue.set':
      return true
    case 'item.add':
      return relevant(op.item) || relevant(itemOf(op.item.id))
    case 'item.status':
    case 'item.remove':
      return relevant(itemOf(op.itemId))
    default:
      return false
  }
}

export function pendingReplyText(question: PendingQuestion, answer: string): string {
  return askReplyText(
    question.replyIds.map((questionItemId) => ({
      questionItemId,
      question: question.title,
      answer,
    })),
  )
}

export function pendingQuestions(
  turns: readonly TurnView[],
  itemOf: (id: string) => ItemView | undefined,
  answers: AskAnswers,
  queued: readonly QueuedMessage[] = [],
): PendingQuestion[] {
  const answered = { ...answers }
  for (const message of queued)
    for (const reply of parseAskReply(message.text) ?? [])
      answered[reply.questionItemId] = reply.answer
  const pending = new Map<string, PendingQuestion>()
  for (const turn of turns) {
    for (const [index, itemId] of turn.itemIds.entries()) {
      const item = itemOf(itemId)
      if (!item) continue
      if (
        item.kind === 'userMessage' &&
        isUserReply(item, turn.origin, index) &&
        !parseAskReply(item.text)
      )
        pending.clear()
      if (item.kind === 'toolCall' && item.status === 'completed') {
        for (const title of item.wrapUp?.withdrawQuestions ?? []) {
          for (const [key, question] of pending) if (question.title === title) pending.delete(key)
        }
      }
      const questions =
        item.kind === 'agentMessage'
          ? (item.questions ?? []).map((q) => ({
              id: q.id,
              title: q.title,
              options: q.options.map((label) => ({ label, answer: label })),
            }))
          : item.kind === 'toolCall' &&
              item.wrapUp?.ask &&
              item.status === 'completed' &&
              turn.status !== 'running'
            ? [
                {
                  id: wrapQuestionId(itemId),
                  title: item.wrapUp.ask,
                  options: (item.wrapUp.actions ?? []).map((a) => ({
                    label: a.label,
                    answer: a.message?.trim() || a.label,
                  })),
                },
              ]
            : []
      for (const question of questions) {
        // 已答的调用不影响之后重新提出的同题。仍在等待的同题合并。
        if (answered[question.id] !== undefined) continue
        const key = JSON.stringify([question.title.trim(), question.options])
        const existing = pending.get(key)
        if (existing) existing.replyIds.push(question.id)
        else
          pending.set(key, {
            ...question,
            kind: item.kind === 'toolCall' ? 'wrap' : 'async',
            itemId,
            turnId: turn.id,
            replyIds: [question.id],
          })
      }
    }
  }
  return [...pending.values()]
}

/** 快照、重连和历史改写走同一条派生路径。 */
export function questionsOfView(view: {
  turns: readonly TurnView[]
  items: Record<string, ItemView>
  queued: readonly QueuedMessage[]
}): PendingQuestion[] {
  const ordered = view.turns.flatMap((turn) => turn.itemIds.flatMap((id) => view.items[id] ?? []))
  return pendingQuestions(
    view.turns,
    (id) => view.items[id],
    gatherAnswers({}, ordered),
    view.queued,
  )
}
