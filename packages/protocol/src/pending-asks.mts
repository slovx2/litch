// 会话待答集合的纯派生，客户端与设备使用同一份，不依赖 Node 或核心。
import { type AskAnswers, askReplyText, gatherAnswers, parseAskReply } from './async-asks.mjs'
import { isUserReply } from './user-reply.mjs'

export interface PendingItem {
  id: string
  kind: string
  questionSource?: string
  text?: string
  attachments?: readonly unknown[]
  peer?: unknown
  system?: { kind: string }
  event?: { notes: readonly unknown[] }
  span?: { from: number }
  status?: string
  questions?: { id: string; title: string; options: string[] }[]
  wrapUp?: {
    ask?: string
    actions?: { label: string; message?: string }[]
    withdrawQuestions?: string[]
  } | null
}
export interface PendingTurn {
  id: string
  status: string
  itemIds: readonly string[]
  startedAt: number | null
  origin?: string
}
export interface PendingQuestion {
  kind: 'wrap' | 'async'
  id: string
  itemId: string
  turnId: string
  title: string
  options: { label: string; answer: string }[]
  replyIds: string[]
  sourceIds: string[]
  proposedAt: number | null
  reportsAfter: number
  ignored: boolean
}
export const questionSource = (turnId: string, itemId: string): string =>
  JSON.stringify([turnId, itemId])
export const wrapQuestionId = (itemId: string, source?: string): string =>
  JSON.stringify(['wrap_up', source ? (JSON.parse(source) as string[]).join(':') : itemId])

/** 忽略键只认来源的结构，不要求设备先整读历史确认它仍在。 */
export function isQuestionSourceId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4000) return false
  try {
    const parts: unknown = JSON.parse(value)
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      !['wrap', 'async'].includes(parts[0]) ||
      typeof parts[1] !== 'string' ||
      !Number.isSafeInteger(parts[2]) ||
      parts[2] < 0
    )
      return false
    const source: unknown = JSON.parse(parts[1])
    return (
      Array.isArray(source) &&
      source.length === 2 &&
      source.every((id) => typeof id === 'string' && id.trim().length > 0)
    )
  } catch {
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
  turns: readonly PendingTurn[],
  itemOf: (id: string) => PendingItem | undefined,
  answers: AskAnswers,
  queued: readonly { text: string }[] = [],
  ignoredIds: readonly string[] = [],
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
        !parseAskReply(item.text ?? '')
      )
        pending.clear()
      if (item.kind === 'userMessage' && item.event)
        for (const q of pending.values()) q.reportsAfter += item.event.notes.length
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
                  id: wrapQuestionId(itemId, item.questionSource),
                  title: item.wrapUp.ask,
                  options: (item.wrapUp.actions ?? []).map((a) => ({
                    label: a.label,
                    answer: a.message?.trim() || a.label,
                  })),
                },
              ]
            : []
      for (const [questionIndex, question] of questions.entries()) {
        // 已答的调用不影响之后重新提出的同题。仍在等待的同题合并。
        if (answered[question.id] !== undefined) continue
        const key = JSON.stringify([question.title.trim(), question.options])
        const sourceId = JSON.stringify([
          item.kind === 'toolCall' ? 'wrap' : 'async',
          item.questionSource ?? item.id,
          questionIndex,
        ])
        const existing = pending.get(key)
        if (existing) {
          existing.replyIds.push(question.id)
          existing.sourceIds.push(sourceId)
          existing.ignored &&= ignoredIds.includes(sourceId)
        } else
          pending.set(key, {
            ...question,
            kind: item.kind === 'toolCall' ? 'wrap' : 'async',
            itemId,
            turnId: turn.id,
            replyIds: [question.id],
            sourceIds: [sourceId],
            proposedAt: item.span?.from ?? turn.startedAt ?? null,
            reportsAfter: 0,
            ignored: ignoredIds.includes(sourceId),
          })
      }
    }
  }
  return [...pending.values()]
}

/** 已加载的历史和排队答复走同一份派生。 */
export function questionsOfView(view: {
  turns: readonly PendingTurn[]
  items: Record<string, PendingItem>
  queued: readonly { text: string }[]
  ignoredQuestions?: readonly string[]
}): PendingQuestion[] {
  const ordered = view.turns.flatMap((turn) => turn.itemIds.flatMap((id) => view.items[id] ?? []))
  return pendingQuestions(
    view.turns,
    (id) => view.items[id],
    gatherAnswers({}, ordered),
    view.queued,
    view.ignoredQuestions,
  )
}
