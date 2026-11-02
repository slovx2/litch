import type { SessionOp } from '../channel/protocol.mjs'
import type { SessionView } from '../model.mjs'
import { reduceSession } from '../projection/reduce.mjs'
import type { PendingInputStore } from './pending-inputs.mjs'

/** 只有恢复材料已可靠落盘的明确取消项才离开对话；未知和无来源关系的历史不隐藏。 */
export function withdrawnInputOps(view: SessionView, withdrawn: ReadonlySet<string>): SessionOp[] {
  if (!withdrawn.size) return []
  return view.turns.flatMap((turn) =>
    turn.itemIds.flatMap((itemId): SessionOp[] => {
      const item = view.items[itemId]
      return item?.kind === 'userMessage' &&
        item.delivery !== 'sent' &&
        item.clientId &&
        withdrawn.has(item.clientId)
        ? [{ op: 'item.remove', turnId: turn.id, itemId }]
        : []
    }),
  )
}

/** 冷启动的视图缓存也按独立待发文件对账，不让旧缓存短暂复活撤回气泡。 */
export function restorePendingView(view: SessionView, store: PendingInputStore): SessionView {
  const restored = {
    ...view,
    turns: view.turns.map((turn) => ({ ...turn, itemIds: [...turn.itemIds] })),
    items: { ...view.items },
    queued: store.load(view.sessionId),
  }
  for (const op of withdrawnInputOps(restored, new Set(store.withdrawn(view.sessionId)))) {
    reduceSession(restored, op)
  }
  return restored
}
