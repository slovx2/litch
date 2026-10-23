// 侧面板的“子代理”标签：眼前这个会话里引擎自己派出的子代理（Claude 的 Agent 工具、原生 codex 的子线程）。
// 上面是竖排的列表（类型、描述、用时、状态；进行中的排前面，最多露 5 行，多了自己滚），
// 下面是选中的那一个：标题是描述、右边是状态，元信息一行，派给它的任务（收成三行），再下面是它的对话。
// 能不能在里面直接输入照 canAcceptDirectInput：不能的，核心把会话标成只能看，输入框换成一句说明。
import {
  type AgentRunState,
  type AgentThreadView,
  agentRunState,
  agentStatesOf,
  type ContextUsage,
  type DeviceView,
  type ItemView,
  keys,
  type SessionSummary,
  type TurnView,
} from '@litch/core'
import { memo, useEffect, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { shortTokens } from '../composer/ContextMeter.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { Transcript } from '../transcript/Transcript.tsx'
import { AgentStatus, AgentTime } from './agent-view.tsx'
import { pickAgent, usePickedAgent } from './agents.ts'
import { useAgentList } from './useAgentList.ts'

/** 进行中、排队的排在前面，别的照列表原来的先后（最近动过的在前） */
const RANK: Record<AgentRunState, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  stopped: 2,
  completed: 2,
}

/** 父会话里协作条目报的各个子代理的状态（子线程说不出来时用） */
function useReported(deviceId: string, parentId: string) {
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, parentId)) ?? []
  const turns = useKeys<TurnView>(turnIds.map((id) => keys.turn(deviceId, parentId, id)))
  const items = useKeys<ItemView>(
    turns.flatMap((turn) => turn?.itemIds ?? []).map((id) => keys.item(deviceId, parentId, id)),
  )
  return useMemo(() => agentStatesOf(items), [items])
}

export function AgentsTab({ place, shown }: SideTabProps) {
  const t = useT()
  const { deviceId, sessionId } = place
  const list = useAgentList(deviceId, sessionId, '', shown) ?? []
  const reported = useReported(deviceId, sessionId ?? '')
  const picked = usePickedAgent(deviceId, sessionId)
  const rows = useMemo(
    () =>
      list
        .map((agent) => ({ agent, state: agentRunState(agent, reported.get(agent.id), null) }))
        .sort((a, b) => RANK[a.state] - RANK[b.state]),
    [list, reported],
  )
  const current = picked ?? rows[0]?.agent.id ?? null
  // 没点过的先看排在最前的那个，并记下来：之后状态变了、顺序换了，看着的那个不跟着跳
  useEffect(() => {
    if (!picked && sessionId && current) pickAgent(deviceId, sessionId, current)
  }, [picked, sessionId, current, deviceId])
  if (!sessionId || (rows.length === 0 && current === null)) {
    return <div className="side-none dim">{t('agents.none')}</div>
  }
  const chosen = rows.find((row) => row.agent.id === current)
  return (
    <div className="agents-tab" data-parent={sessionId}>
      {rows.length > 0 ? (
        <div className="agents-list" role="tablist" aria-label={t('agents.list')}>
          {rows.map(({ agent, state }, index) => (
            <button
              key={agent.id}
              type="button"
              role="tab"
              className="agents-pick"
              data-agent={agent.id}
              data-state={state}
              aria-selected={agent.id === current}
              title={agent.prompt || undefined}
              onClick={() => pickAgent(deviceId, sessionId, agent.id)}
            >
              {agent.role ? <span className="agent-kind">{agent.role}</span> : null}
              <span className="agent-desc ell">
                {agent.description || agent.nickname || t('tree.agent.unnamed', { n: index + 1 })}
              </span>
              <span className="agent-meta">
                <AgentTime thread={agent} />
                <AgentStatus state={state} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {current ? (
        <AgentDetail
          key={current}
          deviceId={deviceId}
          parentId={sessionId}
          agentId={current}
          agent={chosen?.agent}
          state={chosen?.state ?? null}
        />
      ) : null}
    </div>
  )
}

/** 这几种条目算一次工具调用（元信息里的“工具 N 次”） */
const TOOL_KINDS: ReadonlySet<ItemView['kind']> = new Set([
  'command',
  'fileChange',
  'toolCall',
  'webSearch',
])

/** 派给它的任务收成几行；多于这么多行、这么多字的才给“展开全部” */
const TASK_LINES = 3
const TASK_CHARS = 120

/** 子线程里调了几次工具。它的对话还没载入是 null */
function useToolCount(deviceId: string, agentId: string): number | null {
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, agentId))
  const turns = useKeys<TurnView>((turnIds ?? []).map((id) => keys.turn(deviceId, agentId, id)))
  const kinds = useKeys<ItemView>(
    turns.flatMap((turn) => turn?.itemIds ?? []).map((id) => keys.item(deviceId, agentId, id)),
  )
  if (!turnIds) return null
  return kinds.filter((item) => item && TOOL_KINDS.has(item.kind)).length
}

/** 选中的那个子代理：标题、状态（进行中能停）、元信息、派给它的任务，下面是它的对话 */
const AgentDetail = memo(function AgentDetail({
  deviceId,
  parentId,
  agentId,
  agent,
  state,
}: {
  deviceId: string
  parentId: string
  agentId: string
  agent: AgentThreadView | undefined
  state: AgentRunState | null
}) {
  const t = useT()
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, parentId))
  const usage = useKey<ContextUsage | null>(keys.usage(deviceId, agentId))
  const tools = useToolCount(deviceId, agentId)
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  // 单独停一个子代理要 harness 声明了会（Claude 入口还不会）
  const canStop =
    state === 'running' &&
    device?.harnesses.find((entry) => entry.id === parent?.harness)?.abilities?.stopAgent === true
  const stop = () => {
    setStopping(true)
    channel
      .command('session.interrupt', { deviceId, sessionId: agentId })
      .catch((error: unknown) =>
        showToast({
          id: 'agent-stop-failed',
          tone: 'err',
          lifeMs: 8000,
          text: (say) => whyNot(error, say),
        }),
      )
      .finally(() => setStopping(false))
  }
  const failure = state === 'failed' ? (agent?.turn?.error ?? null) : null
  const prompt = agent?.prompt ?? ''
  // 三行放得下的不给“展开全部”
  const long = prompt.split('\n').length > TASK_LINES || Array.from(prompt).length > TASK_CHARS
  return (
    <div
      className="agents-view"
      data-agent={agentId}
      data-state={state ?? undefined}
      data-task={prompt ? '' : undefined}
    >
      <div className="agents-head">
        <div className="agents-title">
          <h3>{agent?.description || agent?.nickname || t('tree.agent.unnamed', { n: 1 })}</h3>
          {state ? <AgentStatus state={state} /> : null}
          {canStop ? (
            <button
              type="button"
              className="btn sm"
              title={t('agents.stop.title')}
              disabled={stopping}
              onClick={stop}
            >
              {t('agents.stop')}
            </button>
          ) : null}
        </div>
        <div className="agents-meta">
          {agent?.role ? (
            <span>
              {t('agents.meta.kind')} <b>{agent.role}</b>
            </span>
          ) : null}
          {agent?.nickname ? (
            <span>
              {t('agents.meta.name')} <b>{agent.nickname}</b>
            </span>
          ) : null}
          {agent?.turn ? (
            <span>
              {t('agents.meta.time')} <b>{<AgentTime thread={agent} />}</b>
            </span>
          ) : null}
          {tools !== null && tools > 0 ? (
            <span>
              {t('agents.meta.tools')} <b>{t('agents.meta.toolCount', { n: tools })}</b>
            </span>
          ) : null}
          {usage?.usedTokens ? (
            <span>
              {t('agents.meta.usage')} <b>{shortTokens(usage.usedTokens)}</b>
            </span>
          ) : null}
        </div>
        {prompt ? (
          <div className="agents-task" data-open={open}>
            <div className="agents-task-label">
              <Icon name="file" small />
              {t('agents.task')}
            </div>
            <div className="agents-task-text">{prompt}</div>
            {long ? (
              <button type="button" className="agents-task-more" onClick={() => setOpen(!open)}>
                {t(open ? 'agents.task.less' : 'agents.task.more')}
              </button>
            ) : null}
          </div>
        ) : null}
        {state === 'failed' ? (
          <div className="agents-fail" role="alert">
            <b>{t(tools ? 'agents.fail.run' : 'agents.fail.start')}</b>
            <span>{failure ?? t('agents.fail.unknown')}</span>
          </div>
        ) : null}
      </div>
      {/* 这一块里按的 Esc 归子代理自己的输入区（两下打断的是它的回合，composer/escape.ts） */}
      <div className="agents-transcript" data-esc-scope>
        <Transcript deviceId={deviceId} sessionId={agentId} />
      </div>
    </div>
  )
})
