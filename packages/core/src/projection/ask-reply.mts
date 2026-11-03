// 答复留在发送的位置；只有同回合紧邻原问题卡时，才并回卡片，避免重复。
import { wrapQuestionId } from '../../../protocol/src/pending-asks.mjs'
import type { ItemView, TurnView } from '../model.mjs'
import { parseAskReply } from './asks.mjs'
import { blockInput, bucketItems } from './blocks.mjs'

export function questionIds(item: ItemView): string[] {
  if (item.kind === 'agentMessage') return (item.questions ?? []).map((q) => q.id)
  if (item.kind === 'toolCall' && item.wrapUp?.ask)
    return [wrapQuestionId(item.id, item.questionSource)]
  return []
}

/** 按实际显示的块判断相邻：过程、会话消息和回合边界都会隔开问答。 */
export function adjacentAskReply(
  item: ItemView,
  turn: TurnView | undefined,
  itemOf: (id: string) => ItemView | undefined,
): boolean {
  if (item.kind !== 'userMessage' || item.peer || item.system || item.attachments.length || !turn)
    return false
  const replies = parseAskReply(item.text)
  if (!replies) return false
  const blocks = bucketItems(
    turn.itemIds.flatMap((id) => {
      const value = itemOf(id)
      return value ? [blockInput(id, value)] : []
    }),
    { turnRunning: turn.status === 'running' },
  )
  const at = blocks.findIndex((block) => block.type === 'user' && block.itemId === item.id)
  const previous = blocks[at - 1]
  if (previous?.type !== 'card') return false
  const source = itemOf(previous.itemId)
  return !!source && replies.every((reply) => questionIds(source).includes(reply.questionItemId))
}

/** 只按题目标识找原卡，不按相同题面猜测；历史不在当前窗口时保留引用原文。 */
export function askReplySource(
  questionId: string,
  turns: readonly TurnView[],
  itemOf: (id: string) => ItemView | undefined,
): { itemId: string; turnId: string } | null {
  for (const turn of turns)
    for (const itemId of turn.itemIds) {
      const item = itemOf(itemId)
      if (item && questionIds(item).includes(questionId)) return { itemId, turnId: turn.id }
    }
  return null
}
