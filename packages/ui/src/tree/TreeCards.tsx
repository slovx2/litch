// 对话里露在外面的几种卡片（核心的 cardOf 定哪些条目画成卡片）：
// 派出的 Litch 子会话（litch_sessions.start）：标题、harness、现在怎样、最近一次回报，点一下跳过去；
// 降成提案的 litch_sessions.start：建议任务的卡片（ProposalCard.tsx）；
// 引擎自己启动的子代理（collabAgentToolCall）：每个子代理一行，谁、在做什么、怎样了，点一下在侧面板里看。
import {
  type AgentRefView,
  type AgentState,
  type DeviceView,
  keys,
  type SessionNotes,
  type SessionSummary,
  type ToolCallItem,
} from '@litch/core'
import { memo } from 'react'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from '../transcript/actions.tsx'
import { type ItemRef, useItem } from '../transcript/messages.tsx'
import { openAgent } from './agents.ts'
import { ProposalCard } from './ProposalCard.tsx'
import { useAgentList } from './useAgentList.ts'

/** 侧栏行首那个状态点的画法：在跑、在等人、出错，别的不画 */
export const markOf = (status: SessionSummary['status'] | undefined): string =>
  status === 'running' ? 'run' : status === 'waiting' ? 'wait' : status === 'error' ? 'err' : ''

const AGENT_MARK: Record<AgentState, string> = {
  pendingInit: 'run',
  running: 'run',
  interrupted: '',
  completed: '',
  errored: 'err',
  shutdown: '',
  notFound: 'err',
}

/** 派出的一个子会话（模型直接起的） */
const SpawnCard = memo(function SpawnCard(ref: ItemRef) {
  const { deviceId, sessionId } = ref
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  const { open } = useActions()
  const spawned = item?.kind === 'toolCall' ? item.spawned : undefined
  const childId = spawned?.threadId ?? ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const notes = useKey<SessionNotes>(keys.notes(deviceId, sessionId))
  if (item?.kind !== 'toolCall' || !spawned) return null
  const note = childId ? notes?.[childId] : undefined
  const harness = child?.harness ?? spawned.harness
  const failed = item.status === 'failed' || item.error !== null
  const title = spawned.title || (child ? t.text(child.title) : '')
  let state: string
  let mark = ''
  if (item.status === 'inProgress') {
    state = t('tree.spawning')
    mark = 'run'
  } else if (failed) {
    state = t('tree.spawnFailed')
    mark = 'err'
  } else if (!childId) {
    state = ''
  } else if (!child) {
    state = t('tree.child.gone')
  } else {
    state = t(`tree.status.${child.status}`)
    mark = markOf(child.status)
  }
  const body = (
    <>
      <span className="tree-card-kind">
        <Icon name="agents" small />
        {t('tree.spawned')}
      </span>
      <span className="tree-card-line">
        <i className={mark ? `st ${mark}` : 'st'} />
        <b className="ell grow">{title}</b>
        {harness ? (
          <span className="chip" title={nameOf(device, harness)}>
            {badgeOf(device, harness)}
          </span>
        ) : null}
        <span className="tree-card-state">{state}</span>
      </span>
    </>
  )
  const canOpen = child !== undefined && open !== undefined
  return (
    <div
      className="tree-card"
      data-card="spawn"
      data-child={childId}
      data-item={ref.itemId}
      data-anchor={`i:${ref.itemId}`}
    >
      {canOpen ? (
        <button
          type="button"
          className="tree-card-main"
          title={t('tree.child.open')}
          onClick={() => open({ deviceId, sessionId: childId })}
        >
          {body}
        </button>
      ) : (
        <div className="tree-card-main">{body}</div>
      )}
      {note?.excerpt ? (
        <div className="tree-card-report">
          <span className="tree-card-label">{t('tree.child.report')}</span>
          <span className="tree-card-text">{note.excerpt}</span>
        </div>
      ) : null}
    </div>
  )
})

/** 一个子代理那一行 */
function AgentLine({
  deviceId,
  parentId,
  agent,
  index,
  nickname,
  role,
}: {
  deviceId: string
  parentId: string
  agent: AgentRefView
  index: number
  nickname: string | null
  role: string | null
}) {
  const t = useT()
  const mark = agent.state ? AGENT_MARK[agent.state] : ''
  return (
    <li>
      <button
        type="button"
        className="tree-agent"
        data-agent={agent.threadId}
        title={t('tree.agent.open')}
        onClick={() => openAgent(deviceId, parentId, agent.threadId)}
      >
        <i className={mark ? `st ${mark}` : 'st'} />
        <b className="tree-agent-name">{nickname ?? t('tree.agent.unnamed', { n: index + 1 })}</b>
        {role ? <span className="tree-agent-role">{role}</span> : null}
        <span className="tree-agent-msg ell grow">{agent.message ?? ''}</span>
        <span className="tree-card-state">
          {t(agent.state ? `tree.agent.${agent.state}` : 'tree.agent.unknown')}
        </span>
      </button>
    </li>
  )
}

/** 启动子代理的那一次调用 */
const AgentsCard = memo(function AgentsCard(ref: ItemRef) {
  const { deviceId, sessionId } = ref
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  const agents = item?.kind === 'toolCall' ? (item.agents ?? []) : []
  // 子代理的状态变了再问一次列表：新起的子代理那时才有昵称
  const stamp = agents.map((agent) => `${agent.threadId}=${agent.state ?? ''}`).join(',')
  const list = useAgentList(deviceId, sessionId, stamp, agents.length > 0)
  if (item?.kind !== 'toolCall') return null
  const prompt = item.input.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n')
  return (
    <div className="tree-card" data-card="agents" data-anchor={`i:${ref.itemId}`}>
      <div className="tree-card-main">
        <span className="tree-card-kind">
          {item.status === 'inProgress' && agents.length === 0 ? (
            <i className="st run" />
          ) : (
            <Icon name="agents" small />
          )}
          {agents.length > 0 ? t('tree.agents.title', { n: agents.length }) : t.text(item.tool)}
          {item.status === 'failed' ? <span className="minus">{t('status.failed')}</span> : null}
        </span>
        {prompt ? <span className="tree-card-text">{prompt}</span> : null}
      </div>
      {agents.length === 0 ? null : (
        <ul className="tree-agents">
          {agents.map((agent, index) => {
            const known = list?.find((entry) => entry.id === agent.threadId)
            return (
              <AgentLine
                key={agent.threadId}
                deviceId={deviceId}
                parentId={sessionId}
                agent={agent}
                index={index}
                nickname={known?.nickname ?? null}
                role={known?.role ?? null}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
})

/** 对话里的一张卡片：按条目里带的是哪一种来画 */
export const TreeCard = memo(function TreeCard(ref: ItemRef) {
  const item = useItem<ToolCallItem>(ref)
  if (item?.kind !== 'toolCall') return null
  // 降成提案、还没直接起出子会话的：建议任务的卡片
  if (item.spawned?.proposalId && !item.spawned.threadId)
    return <ProposalCard {...ref} item={item} />
  return item.spawned ? <SpawnCard {...ref} /> : <AgentsCard {...ref} />
})
