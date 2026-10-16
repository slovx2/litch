import { ProtocolError } from './protocol-contract.mjs'
import type { TurnRecord } from './types.mjs'

// thread/fork 的分叉位置：through 保留到这一轮为止（含这一轮），before 从这一轮起都不要。
export type ForkPosition = { kind: 'through' | 'before'; turnId: string }

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
  // 与原生一致：保留到的那一轮必须已经结束；切在进行中的回合之前则不受限。
  if (target.status === 'inProgress')
    throw new ProtocolError(-32602, 'lastTurnId 指向的回合仍在进行中')
  return turns.slice(0, index + 1)
}
