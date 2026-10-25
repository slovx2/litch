// 一个会话的后台任务（回合结束后还在跑的工作）：输入框上方那一行、侧面板的“后台任务”页、收起行上的记号都用它。
// 对面报集合的照侧栏摘要上的那份（SessionSummary.background）；不报的从最近几个已结束的回合里
// 还在跑的命令派生（核心的 deriveBackground）。界面只认结果，不区分是哪一种来的。
// 输入框上方那一行和“后台任务”页列的是合起来的一张（useBackgroundEntries）：再加上引擎自己的子代理，
// 界面上都叫后台任务。会话树里派出的子会话不算（用户要求，2026-10-25）。
import {
  type AgentState,
  type AgentThreadView,
  type BackgroundEntriesView,
  backgroundEntries,
  deriveBackground,
  type ItemView,
  keys,
  type SessionBackgroundView,
  type SessionMeta,
  type SessionSummary,
  type TurnView,
} from '@litch/core'
import { useMemo } from 'react'
import { useKey, useKeys } from '../app/services.tsx'
import { useAgentList } from '../tree/useAgentList.ts'

/** 派生时看最近几个回合。更早的回合里还挂着没结束的命令，多半是对面早就忘了的 */
const DERIVE_TURNS = 20

const NO_KEYS: readonly string[] = []

export function useSessionBackground(
  deviceId: string,
  sessionId: string | null,
): SessionBackgroundView | null {
  const summary = useKey<SessionSummary>(sessionId ? keys.summary(deviceId, sessionId) : '')
  const meta = useKey<SessionMeta>(sessionId ? keys.session(deviceId, sessionId) : '')
  // 会话内容还没载入时先信摘要：报集合的会话一打开就有，不报的摘要上本来就是 null
  const reports = meta ? meta.can.backgroundTasks : true
  const turnIds = useKey<string[]>(sessionId && !reports ? keys.turnIds(deviceId, sessionId) : '')
  const turnKeys = useMemo(
    () =>
      sessionId && turnIds
        ? turnIds.slice(-DERIVE_TURNS).map((id) => keys.turn(deviceId, sessionId, id))
        : NO_KEYS,
    [deviceId, sessionId, turnIds],
  )
  const turns = useKeys<TurnView>(turnKeys)
  // 只订阅已结束回合里的条目：进行中的回合不算后台，里面的条目还在一个字一个字地变
  const itemIds = useMemo(
    () => turns.flatMap((turn) => (turn && turn.status !== 'running' ? turn.itemIds : [])),
    [turns],
  )
  const itemKeys = useMemo(
    () => (sessionId ? itemIds.map((id) => keys.item(deviceId, sessionId, id)) : NO_KEYS),
    [deviceId, sessionId, itemIds],
  )
  const items = useKeys<ItemView>(itemKeys)
  return useMemo(() => {
    if (reports) return summary?.background ?? null
    const byId: Record<string, ItemView | undefined> = {}
    itemIds.forEach((id, at) => {
      byId[id] = items[at]
    })
    return deriveBackground(
      turns.filter((turn): turn is TurnView => turn !== undefined),
      byId,
    )
  }, [reports, summary, turns, itemIds, items])
}

const NO_AGENTS: readonly AgentThreadView[] = []
const NO_REPORTED: ReadonlyMap<string, AgentState> = new Map()

/**
 * 输入框上方那一行、“后台任务”页列的整张：集合里的后台任务、引擎自己的子代理（父会话开着时核心推来的
 * keys.agents）。reported 是父会话条目里报的子代理状态（页上要准，那一行不订条目）
 */
export function useBackgroundEntries(
  deviceId: string,
  sessionId: string | null,
  reported: ReadonlyMap<string, AgentState> = NO_REPORTED,
): BackgroundEntriesView | null {
  const background = useSessionBackground(deviceId, sessionId)
  const agents = useAgentList(deviceId, sessionId)
  return useMemo(
    () => backgroundEntries(background, agents ?? NO_AGENTS, reported),
    [background, agents, reported],
  )
}

/** 一个任务跑了多久（毫秒）。不知道开始时间的是 null */
export const elapsedOf = (
  task: { startedAt: number | null; endedAt: number | null },
  now: number,
): number | null => (task.startedAt === null ? null : (task.endedAt ?? now) - task.startedAt)
