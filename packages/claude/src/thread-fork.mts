import { ProtocolError } from './protocol-contract.mjs'
import type { TurnRecord } from './types.mjs'

// thread/fork 的分叉位置：through 保留到这一轮为止（含这一轮），before 从这一轮起都不要，
// beforeItem 保留到这一轮里插进去的那条用户消息之前（thread/revert 切在回合中间时也用它）。
export type ForkPosition =
  | { kind: 'through' | 'before'; turnId: string }
  | { kind: 'beforeItem'; turnId: string; itemId: string }

function optionalTurnId(value: unknown, name: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new ProtocolError(-32602, `${name} 必须是字符串`)
  return value
}

// 只看参数本身，不读线程状态；两个参数都没给时返回 null，表示整份复制。
export function forkPositionFromParams(params: Record<string, unknown>): ForkPosition | null {
  const lastTurnId = optionalTurnId(params.lastTurnId, 'lastTurnId')
  const beforeTurnId = optionalTurnId(params.beforeTurnId, 'beforeTurnId')
  if (lastTurnId !== null && beforeTurnId !== null)
    throw new ProtocolError(-32602, 'beforeTurnId 不能与 lastTurnId 同时指定')
  const beforeItemId = optionalTurnId(params.beforeItemId, 'beforeItemId')
  if (beforeItemId !== null) {
    if (beforeTurnId === null)
      throw new ProtocolError(-32602, 'beforeItemId 要和 beforeTurnId 一起指定')
    return { kind: 'beforeItem', turnId: beforeTurnId, itemId: beforeItemId }
  }
  if (lastTurnId !== null) return { kind: 'through', turnId: lastTurnId }
  if (beforeTurnId !== null) return { kind: 'before', turnId: beforeTurnId }
  return null
}

// 分叉要带走的回合。位置里的 ID 是源线程的回合 ID，只认源线程当前历史里的回合。
export function forkRetainedTurns(
  turns: TurnRecord[],
  position: ForkPosition | null,
): TurnRecord[] {
  if (!position) return turns
  const name = position.kind === 'through' ? 'lastTurnId' : 'beforeTurnId'
  const index = turns.findIndex((turn) => turn.id === position.turnId)
  const target = turns[index]
  if (!target) throw new ProtocolError(-32602, `${name} 不属于此会话的当前历史`)
  if (position.kind === 'before') return turns.slice(0, index)
  if (position.kind === 'beforeItem') {
    if (target.status === 'inProgress')
      throw new ProtocolError(-32602, 'beforeTurnId 指向的回合仍在进行中，不能切在回合中间')
    const at = target.items.findIndex((item) => item.id === position.itemId)
    if (at < 0 || target.items[at]?.type !== 'userMessage')
      throw new ProtocolError(-32602, 'beforeItemId 不是这个回合里的用户消息')
    // 切在回合的第一个条目之前，就是整个回合都不要
    if (at === 0) return turns.slice(0, index)
    return [...turns.slice(0, index), { ...target, items: target.items.slice(0, at) }]
  }
  // 与原生一致：保留到的那一轮必须已经结束；切在进行中的回合之前则不受限。
  if (target.status === 'inProgress')
    throw new ProtocolError(-32602, 'lastTurnId 指向的回合仍在进行中')
  return turns.slice(0, index + 1)
}
