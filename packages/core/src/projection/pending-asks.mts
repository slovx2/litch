import type { SessionOp } from '../channel/protocol.mjs'
import type { ItemView } from '../model.mjs'

export * from '../../../protocol/src/pending-asks.mjs'

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
    case 'session.ignoredQuestions':
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
