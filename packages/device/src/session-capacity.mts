// 所有新增工作（派线、恢复后开回合、send 唤起）共用同一套计数与原子占位。
import { SESSION_TREE_LIMITS } from '../../protocol/src/session-tree.mjs'
import type { SessionTree } from './session-tree.mjs'

/** 派不出来：说明是给人（或模型）看的 */
export class StartRefused extends Error {
  readonly kind: 'invalid' | 'blocked' | 'forbidden'

  constructor(kind: 'invalid' | 'blocked' | 'forbidden', message: string) {
    super(message)
    this.kind = kind
  }
}

type Slot = { parentId: string; threadId: string | null }
const reservations = new WeakMap<SessionTree, Set<Slot>>()
const noop = { bind: (_id: string) => {}, release: () => {} }

export function sessionParents(tree: SessionTree): Map<string, string> {
  const parents = new Map(tree.store.childStarts().map((row) => [row.threadId, row.parentId]))
  for (const row of tree.store.children()) parents.set(row.threadId, row.parentThreadId)
  return parents
}

export function treePosition(threadId: string, parents: Map<string, string>) {
  let root = threadId
  let depth = 0
  const seen = new Set<string>()
  while (parents.has(root)) {
    if (seen.has(root)) throw new StartRefused('forbidden', 'The session tree contains a cycle.')
    seen.add(root)
    root = parents.get(root) as string
    depth++
  }
  return { root, depth }
}

export async function reserveSessionWork(
  tree: SessionTree,
  parentId: string,
  threadId: string | null,
): Promise<{ bind(id: string): void; release(): void }> {
  // 所有回合仍先经过原有异步配额入口，不能按角色提前短路。
  // EngineLink 在等待结束、真正发送前复查停止票与重启屏障。
  const manager = tree.managers?.lines.managerFor(parentId)
  const managerReservation = await tree.managers?.lines.reserve(parentId, threadId)
  // 经理子树以配置的工作线限额覆盖普通会话的 8/24 并发保护。
  if (manager) return managerReservation ?? noop
  const parents = sessionParents(tree)
  if (threadId) {
    const parent = parents.get(threadId)
    if (!parent && tree.store.childrenOf(threadId).length === 0) return noop
    parentId = parent ?? threadId
  }
  let slots = reservations.get(tree)
  if (!slots) reservations.set(tree, (slots = new Set()))
  if (threadId && (tree.occupiesSlot(threadId) || [...slots].some((s) => s.threadId === threadId)))
    return noop
  const root = treePosition(parentId, parents).root
  const live = new Set([root, ...parents.keys()].filter((id) => tree.occupiesSlot(id)))
  for (const hold of tree.store.childStarts()) live.add(hold.threadId)
  for (const slot of slots) if (slot.threadId) live.add(slot.threadId)
  // 已建成的会话按 ID 去重；尚未建成的请求各占一位。
  const unnamed = [...slots].filter((slot) => !slot.threadId)
  const treeCount =
    [...live].filter((id) => treePosition(id, parents).root === root).length +
    unnamed.filter((slot) => treePosition(slot.parentId, parents).root === root).length
  const childCount =
    [...live].filter((id) => parents.get(id) === parentId).length +
    unnamed.filter((slot) => slot.parentId === parentId).length
  // 恢复一个启动结果未确认的会话只使用原来的占位。
  if (threadId && live.has(threadId)) return noop
  if (treeCount >= SESSION_TREE_LIMITS.liveTree)
    throw new StartRefused(
      'forbidden',
      `Session tree capacity: ${treeCount} sessions running or starting (limit ${SESSION_TREE_LIMITS.liveTree}, including the root). Wait for work to finish.`,
    )
  if ((!threadId || parents.has(threadId)) && childCount >= SESSION_TREE_LIMITS.liveChildren)
    throw new StartRefused(
      'blocked',
      `Direct child capacity: ${childCount} sub-sessions running or starting (the limit is ${SESSION_TREE_LIMITS.liveChildren}). Wait for one to finish first.`,
    )
  const slot: Slot = { parentId, threadId }
  slots.add(slot)
  return {
    bind: (id) => {
      slot.threadId = id
    },
    release: () => {
      slots.delete(slot)
    },
  }
}
