// 对话区里哪些回合并成跨回合的收起块（规矩在核心的 systemRuns）。整个对话区算一次，结果按回合交给各个 Turn。
// 只订阅画出来的那几个回合和子代理列表：回合的条目增减、状态变了才重算；文字增量只改条目，不在这里引起重算。
// 每个回合的收起样子按回合对象缓存，没变的回合拿到的还是上一次的对象，Turn 不跟着重画。
import {
  type AgentThreadView,
  agentsUnfinished,
  blockInput,
  bucketItems,
  type FoldTurn,
  foldTurnOf,
  type ItemView,
  keys,
  type RunRole,
  sameRun,
  systemRuns,
  type TurnView,
} from '@litch/core'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useServices } from '../app/services.tsx'

interface Cached {
  turn: TurnView
  agents: AgentThreadView[] | undefined
  shape: FoldTurn
}

const NO_RUNS: ReadonlyMap<string, RunRole> = new Map()

/**
 * 画出来的回合（按先后）里，各自在哪个收起块里。gaps 是查找时跳过了几个回合的位置（那个回合前面有跳行）：前后不并
 */
export function useSystemRuns(
  deviceId: string,
  sessionId: string,
  turnIds: readonly string[] | undefined,
  gaps: ReadonlyMap<string, number>,
): ReadonlyMap<string, RunRole> {
  const { store } = useServices().replica
  const cache = useRef({
    shapes: new Map<string, Cached>(),
    roles: NO_RUNS as ReadonlyMap<string, RunRole>,
  })
  const joined = turnIds?.join('\n') ?? ''
  const subscribe = useCallback(
    (listener: () => void) => {
      const ids = joined ? joined.split('\n') : []
      const offs = [
        ...ids.map((id) => keys.turn(deviceId, sessionId, id)),
        keys.agents(deviceId, sessionId),
      ].map((key) => store.subscribe(key, listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [store, deviceId, sessionId, joined],
  )
  return useSyncExternalStore(subscribe, () => {
    const ids = joined ? joined.split('\n') : []
    const agents = store.get<AgentThreadView[]>(keys.agents(deviceId, sessionId))
    const read = (id: string) => store.get<ItemView>(keys.item(deviceId, sessionId, id))
    const shapes: (FoldTurn | null)[] = []
    const next = new Map<string, Cached>()
    for (const id of ids) {
      if (gaps.has(id)) shapes.push(null)
      const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, id))
      if (!turn) {
        shapes.push(null)
        continue
      }
      const old = cache.current.shapes.get(id)
      if (old && old.turn === turn && old.agents === agents) {
        next.set(id, old)
        shapes.push(old.shape)
        continue
      }
      const items = turn.itemIds.map(read)
      const inputs = items.flatMap((item, index) => {
        const itemId = turn.itemIds[index]
        return item && itemId ? [blockInput(itemId, item)] : []
      })
      const blocks = bucketItems(inputs, { turnRunning: turn.status === 'running' })
      const shape = foldTurnOf(turn, blocks, read, agentsUnfinished(items, agents))
      // 条目还没到齐时不缓存，到齐后回合对象不变也要重算
      if (inputs.length === turn.itemIds.length) next.set(id, { turn, agents, shape })
      shapes.push(shape)
    }
    cache.current.shapes = next
    const fresh = systemRuns(shapes)
    const previous = cache.current.roles
    // 没变的块沿用上一次的对象：成员、标题行、领头都一样时 Turn 拿到的 run 也是同一个
    let changed = fresh.size !== previous.size
    const roles = new Map<string, RunRole>()
    for (const [id, role] of fresh) {
      const old = previous.get(id)
      if (old && old.head === role.head && old.lead === role.lead && old.whole === role.whole) {
        if (sameRun(old.run, role.run)) {
          roles.set(id, old)
          continue
        }
      }
      changed = true
      roles.set(id, role)
    }
    if (!changed) return previous
    // 同一块的成员共用同一个 run 对象
    const shared = new Map<string, RunRole['run']>()
    for (const [id, role] of roles) {
      const run = shared.get(role.run.key) ?? role.run
      shared.set(role.run.key, run)
      if (run !== role.run) roles.set(id, { ...role, run })
    }
    cache.current.roles = roles
    return roles
  })
}
