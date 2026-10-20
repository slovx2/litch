// 对话里露在外面的几种卡片（核心的 cardOf 定哪些条目画成卡片）：
// 派出的 Litch 子会话（litch_sessions.start）：标题、harness、现在怎样、最近一次回报，点一下跳过去；
// 交给分叉会话的 litch_sessions.hand_off：和派出的子会话同一种卡，只是写“交给了分叉会话”；
// 降成提案的 litch_sessions.start、带了建议的收尾（litch_sessions.wrap_up）：建议任务的卡片（ProposalCard.tsx）；
// initiation offer 的 litch_sessions.start：“新会话 / 在这里做”的卡（OfferCard.tsx）；
// 引擎自己启动的子代理（collabAgentToolCall）：每个子代理一行小条（类型、描述、用时、状态），点一下在右侧“子代理”页里看；
// 带题的助手消息（模型边干活边问）：问题卡片（transcript/AskCard.tsx）。
import {
  type AgentMessageItem,
  type AgentRefView,
  type AgentRunState,
  type AgentThreadView,
  type DeviceView,
  firstSentence,
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
import { AskCard } from '../transcript/AskCard.tsx'
import { useActions } from '../transcript/actions.tsx'
import { type ItemRef, useItem } from '../transcript/messages.tsx'
import { AgentStatus, AgentTime, useAgentStates } from './agent-view.tsx'
import { openAgent } from './agents.ts'
import { OfferCard } from './OfferCard.tsx'
import { ProposalCard, WrapUpCards } from './ProposalCard.tsx'
import { useAgentList } from './useAgentList.ts'

/** 侧栏行首那个状态点的画法：在跑、在等人、出错，别的不画 */
export const markOf = (status: SessionSummary['status'] | undefined): string =>
  status === 'running' ? 'run' : status === 'waiting' ? 'wait' : status === 'error' ? 'err' : ''

/** 派出的一个子会话（模型直接起的），或者交接出去的分叉会话（hand_off） */
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
  const handOff = spawned.via === 'handOff'
  let state: string
  let mark = ''
  if (item.status === 'inProgress') {
    state = t(handOff ? 'tree.handingOff' : 'tree.spawning')
    mark = 'run'
  } else if (failed) {
    state = t(handOff ? 'tree.handOffFailed' : 'tree.spawnFailed')
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
        {t(handOff ? 'tree.handedOff' : 'tree.spawned')}
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
      data-card={handOff ? 'hand-off' : 'spawn'}
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

/** 鼠标停在子代理那一行上时给的提示：任务说明的前几行 */
const TIP_LINES = 4
const TIP_CHARS = 280

function tipOf(prompt: string): string | undefined {
  const lines = prompt.split('\n').filter((line) => line.trim().length > 0)
  let tip = lines.slice(0, TIP_LINES).join('\n')
  if (Array.from(tip).length > TIP_CHARS) tip = `${Array.from(tip).slice(0, TIP_CHARS).join('')}…`
  else if (lines.length > TIP_LINES) tip = `${tip}\n…`
  return tip || undefined
}

/**
 * 子代理在对话流里的一行：类型、一句话描述、用时、状态，点了在右侧“子代理”页里看它。
 * 不摊开任务说明，鼠标停一下给前几行
 */
function AgentRow({
  deviceId,
  parentId,
  threadId,
  thread,
  state,
  fallback,
  index,
}: {
  deviceId: string
  parentId: string
  /** 还不知道子线程是谁（刚开始派）是 null，这时不能点 */
  threadId: string | null
  thread: AgentThreadView | undefined
  state: AgentRunState
  /** 条目里的任务说明：子线程那边没有描述、没有任务时用它 */
  fallback: string
  index: number
}) {
  const t = useT()
  const prompt = thread?.prompt || fallback
  const description =
    thread?.description ||
    firstSentence(fallback) ||
    thread?.nickname ||
    t('tree.agent.unnamed', { n: index + 1 })
  const body = (
    <>
      <Icon name="agents" small />
      {thread?.role ? <span className="agent-kind">{thread.role}</span> : null}
      <span className="agent-desc ell">{description}</span>
      <span className="agent-meta">
        <AgentTime thread={thread} />
        <AgentStatus state={state} />
      </span>
    </>
  )
  if (!threadId)
    return (
      <div className="agent-row" data-state={state} title={tipOf(prompt)}>
        {body}
      </div>
    )
  return (
    <button
      type="button"
      className="agent-row"
      data-agent={threadId}
      data-state={state}
      title={[tipOf(prompt), t('tree.agent.open')].filter(Boolean).join('\n\n')}
      onClick={() => openAgent(deviceId, parentId, threadId)}
    >
      {body}
      <span className="agent-go" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

/** 启动子代理的那一次调用：每个子代理一行，并行派出的排在一起 */
const AgentsCard = memo(function AgentsCard(ref: ItemRef) {
  const { deviceId, sessionId } = ref
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  const agents = item?.kind === 'toolCall' ? (item.agents ?? NO_AGENTS) : NO_AGENTS
  // 父会话的子代理列表（第一次在这里问；之后核心跟着子线程的回合推来）
  useAgentList(deviceId, sessionId, '', agents.length > 0)
  const states = useAgentStates(ref, agents)
  if (item?.kind !== 'toolCall') return null
  const prompt = item.input.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n')
  return (
    <div className="agents-rows" data-card="agents" data-anchor={`i:${ref.itemId}`}>
      {agents.length === 0 ? (
        // 刚开始派、还不知道是谁；或者没派出去
        <div
          className="agent-row"
          data-state={item.status === 'failed' ? 'failed' : 'queued'}
          title={tipOf(prompt)}
        >
          <Icon name="agents" small />
          <span className="agent-desc ell">
            {firstSentence(prompt) ||
              t(item.status === 'failed' ? 'tree.agent.spawnFailed' : 'tree.agent.spawning')}
          </span>
          <span className="agent-meta">
            <AgentStatus state={item.status === 'failed' ? 'failed' : 'queued'} />
          </span>
        </div>
      ) : (
        states.map((entry, index) => (
          <AgentRow
            key={entry.ref.threadId}
            deviceId={deviceId}
            parentId={sessionId}
            threadId={entry.ref.threadId}
            thread={entry.thread}
            state={entry.state}
            fallback={prompt}
            index={index}
          />
        ))
      )}
    </div>
  )
})

const NO_AGENTS: AgentRefView[] = []

/** 对话里的一张卡片：按条目里带的是哪一种来画 */
export const TreeCard = memo(function TreeCard(ref: ItemRef) {
  const item = useItem<ToolCallItem | AgentMessageItem>(ref)
  // 带题的助手消息（模型边干活边问）
  if (item?.kind === 'agentMessage') return <AskCard {...ref} />
  if (item?.kind !== 'toolCall') return null
  if (item.wrapUp) return <WrapUpCards {...ref} item={item} />
  if (item.spawned?.via === 'offer') return <OfferCard {...ref} item={item} />
  // 降成提案、还没直接起出子会话的：建议任务的卡片
  if (item.spawned?.proposalId && !item.spawned.threadId)
    return <ProposalCard {...ref} item={item} />
  return item.spawned ? <SpawnCard {...ref} /> : <AgentsCard {...ref} />
})
