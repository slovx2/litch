// 引擎自己的子代理在界面上的几样共用的东西：状态（记号加文字，复古皮肤写成方括号）、用时（在跑的走表）、
// 一个子代理现在算什么状态（核心的 agentRunState：子线程自己的回合优先，其次同一回合里协作条目报的，最后是派出时的快照），
// 以及“这个回合里还有没做完的子代理”（回合结束整段收起的判定用）。
import {
  type AgentRefView,
  type AgentRunState,
  type AgentThreadView,
  agentRunState,
  agentStatesOf,
  agentsUnfinished,
  type ItemView,
  keys,
  type TurnView,
} from '@litch/core'
import { useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { duration, elapsed } from '../app/format.ts'
import { useKey, useKeys } from '../app/services.tsx'

/** 状态前面那个记号：进行中闪，失败红，完成绿，排队和已停止不画 */
const MARK: Record<AgentRunState, string> = {
  queued: '',
  running: 'run',
  completed: 'ok',
  failed: 'err',
  stopped: '',
}

/** 一个子代理的状态：记号加文字 */
export function AgentStatus({ state }: { state: AgentRunState }) {
  const t = useT()
  return (
    <span className="agent-st" data-state={state}>
      {MARK[state] === 'run' ? <i className="st run" /> : null}
      <span className="agent-st-text">{t(`tree.agent.state.${state}`)}</span>
    </span>
  )
}

/** 用了多久：做完的取子线程最近一个回合的用时，在跑的从开始的时候走表。说不出来的不画 */
export function AgentTime({ thread }: { thread: AgentThreadView | undefined }) {
  const t = useT()
  const turn = thread?.turn
  const running = turn?.state === 'running' || thread?.status === 'running'
  const spent = useElapsed(running ? (turn?.startedAt ?? null) : null)
  if (running)
    return spent === null ? null : <span className="agent-time">{elapsed(spent, t)}</span>
  if (turn?.durationMs == null) return null
  return <span className="agent-time">{duration(turn.durationMs, t)}</span>
}

/** 父会话的子代理列表（核心按子线程的回合推来的，keys.agents）。会话还没载入是 undefined */
export const useAgents = (deviceId: string, sessionId: string): AgentThreadView[] | undefined =>
  useKey<AgentThreadView[]>(keys.agents(deviceId, sessionId))

/** 一个条目所在回合里的全部条目（按先后）。找不到它在哪个回合是空的 */
function useTurnItems(deviceId: string, sessionId: string, itemId: string) {
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId)) ?? []
  const turns = useKeys<TurnView>(turnIds.map((id) => keys.turn(deviceId, sessionId, id)))
  const turn = turns.find((entry) => entry?.itemIds.includes(itemId))
  return useKeys<ItemView>((turn?.itemIds ?? []).map((id) => keys.item(deviceId, sessionId, id)))
}

/**
 * 派出子代理的那个条目里每个子代理现在的状态，和子代理列表里的它（有的话）。
 * 状态的先后见文件开头：派出时的快照停在“在跑”也不要紧
 */
export function useAgentStates(
  ref: { deviceId: string; sessionId: string; itemId: string },
  agents: readonly AgentRefView[],
): { ref: AgentRefView; thread: AgentThreadView | undefined; state: AgentRunState }[] {
  const list = useAgents(ref.deviceId, ref.sessionId)
  const items = useTurnItems(ref.deviceId, ref.sessionId, ref.itemId)
  return useMemo(() => {
    const reported = agentStatesOf(items)
    return agents.map((agent) => {
      const thread = list?.find((entry) => entry.id === agent.threadId)
      return {
        ref: agent,
        thread,
        state: agentRunState(thread, reported.get(agent.threadId), agent.state),
      }
    })
  }, [agents, items, list])
}

/**
 * 这个回合里还有没有没做完的子代理（排队的、进行中的，或者派出的调用还没结束）。
 * 回合结束后整段过程要不要自动收起时用：还有没做完的就不收（照官方桌面端）
 */
export function useAgentsUnfinished(deviceId: string, sessionId: string, turnId: string): boolean {
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  const items = useKeys<ItemView>(
    (turn?.itemIds ?? []).map((id) => keys.item(deviceId, sessionId, id)),
  )
  const list = useAgents(deviceId, sessionId)
  return useMemo(() => agentsUnfinished(items, list), [items, list])
}
