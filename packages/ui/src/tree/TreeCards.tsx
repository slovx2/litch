// 对话里露在外面的两种卡片（核心的 cardOf 定哪些条目画成卡片）：
// 派出的 Litch 子会话（litch_sessions.start）：标题、harness、现在怎样、最近一次回报，点一下跳过去；
// 引擎自己启动的子代理（collabAgentToolCall）：每个子代理一行，谁、在做什么、怎样了，点一下在侧面板里看。
import {
  type AgentRefView,
  type AgentState,
  type DeviceView,
  keys,
  type ProposalStarts,
  type SessionNotes,
  type SessionProposalView,
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

/** 派出的一个子会话 */
const SpawnCard = memo(function SpawnCard(ref: ItemRef) {
  const { deviceId, sessionId } = ref
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  const { open } = useActions()
  const spawned = item?.kind === 'toolCall' ? item.spawned : undefined
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  // 提案：用户点了“开始”之后，起出来的子会话记着是哪个提案，卡片就当它是派出的那一个
  const startedId = spawned?.proposalId ? starts?.[spawned.proposalId] : undefined
  const childId = spawned?.threadId || startedId || ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const notes = useKey<SessionNotes>(keys.notes(deviceId, sessionId))
  const proposals = useKey<SessionProposalView[]>(keys.proposals(deviceId, sessionId))
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
    // 提案：还挂着就等人点；不要了、过期了都不再挂着（开始了的走下面，和直接派出的一样）
    const pending = proposals?.some((entry) => entry.id === spawned.proposalId) === true
    state = !spawned.proposalId
      ? ''
      : pending
        ? t('tree.child.waitStart')
        : t('tree.proposal.closed')
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
        {t(spawned.proposalId && !spawned.threadId ? 'tree.proposed' : 'tree.spawned')}
        {startedId && !spawned.threadId ? (
          <span className="tree-card-started">{t('tree.proposal.started')}</span>
        ) : null}
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
  return item.spawned ? <SpawnCard {...ref} /> : <AgentsCard {...ref} />
})
