// 条目从开始到结束的时刻（ItemView.span）。协议的条目里没有时间，只有这边看着它开始、结束：
// 增量发出之前（设备的 live.mts、模拟核心）对着手上的视图记上，之后跟着增量走，界面和核心看到的是同一个数。
// 步骤组的时长按组里第一条开始到最后一条结束算（blocks.mts 的 stepsTally），含思考和模型出字的时间。
import type { SessionOp } from '../channel/protocol.mjs'
import type { ItemSpan, ItemView, SessionView } from '../model.mjs'

/** 条目算不算结束了：没有状态的（用户消息、计划、提示、搜索、待办）一出现就算 */
const ended = (item: ItemView): boolean => !('status' in item) || item.status !== 'inProgress'

/**
 * 给一条要换上去的条目记上开始、结束的时刻。previous 是视图里现在那一份：开始的时刻沿用它的，
 * 结束过的不再改（同一条完成的通知来两遍不往后挪）。条目自己带了 span（照着视图里那份改出来的）的以它为准
 */
export function spanned(previous: ItemView | undefined, item: ItemView, now: number): ItemView {
  const before = item.span ?? previous?.span
  const to = ended(item) ? (before?.to ?? now) : null
  if (before && before.to === to) return item.span ? item : { ...item, span: before }
  const span: ItemSpan = { from: before?.from ?? now, to }
  return { ...item, span }
}

/**
 * 一条“添加条目”的增量记上时刻。视图是落这条增量之前的样子，逐条落、逐条记由调用方做。
 * 只记在跑的回合里的：读历史、接手时一次放进来的条目没看着它开始，不记（记了就是零秒）
 */
export function spanOp(view: SessionView, op: SessionOp, now: number): SessionOp {
  if (op.op !== 'item.add') return op
  const previous = view.items[op.item.id]
  const running = view.turns.some((turn) => turn.id === op.turnId && turn.status === 'running')
  if (!running && !previous?.span && !op.item.span) return op
  const item = spanned(previous, op.item, now)
  return item === op.item ? op : { ...op, item }
}

/** 一组条目从第一条开始到最后一条结束用了多久。一条都没记过时刻是 null；还没结束的按开始算 */
export function spanOf(items: readonly ItemView[]): number | null {
  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const span = item.span
    if (!span) continue
    from = Math.min(from, span.from)
    to = Math.max(to, span.to ?? span.from)
  }
  return Number.isFinite(from) ? Math.max(0, to - from) : null
}

/**
 * 一组条目里最早开始的时刻（本机的钟）。一条都没记过时刻是 null。
 * 组里还有在跑的时候，界面拿它一秒一秒地算到现在为止的累计用时（spanOf 只算到已经结束的那一刻）
 */
export function spanFrom(items: readonly ItemView[]): number | null {
  let from: number | null = null
  for (const item of items) {
    const at = item.span?.from
    if (at !== undefined && (from === null || at < from)) from = at
  }
  return from
}
