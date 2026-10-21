// 会话树（sessionTree 扩展）的投影：设备进程发来的提案、引擎自己的子代理线程 → 界面看到的样子。纯函数。
import type { SessionProposal, Thread, Turn } from '../../../protocol/src/index.mjs'
import type { ItemView } from '../model.mjs'
import {
  AGENT_RUN_STATE,
  type AgentRunState,
  type AgentState,
  type AgentThreadView,
  type AgentTurnView,
  agentSettled,
  type ProposalStatus,
  type SandboxLevel,
  type SessionProposalView,
} from '../model-tree.mjs'
import { parentOf, sessionStatus, toMs } from './session.mjs'

const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>([
  'pending',
  'offered',
  'chosen',
  'here',
  'started',
  'dismissed',
  'withdrawn',
  'expired',
])
const LEVELS: ReadonlySet<string> = new Set<SandboxLevel>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

const word = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/**
 * 设备进程给的一个提案 → 界面看到的样子。形状不对（没有 id、不认识的状态）是 null。
 * 还等着、却已经过了期的直接记成过期（设备进程到点会再发一次通知，这里先按时间算）
 */
export function projectProposal(
  proposal: SessionProposal,
  now: number,
): SessionProposalView | null {
  if (typeof proposal !== 'object' || proposal === null) return null
  if (typeof proposal.id !== 'string' || !STATUSES.has(proposal.status)) return null
  const expiresAt = toMs(proposal.expiresAt) ?? 0
  const lapsed = proposal.status === 'pending' && expiresAt <= now
  return {
    id: proposal.id,
    title: typeof proposal.title === 'string' ? proposal.title : '',
    prompt: typeof proposal.prompt === 'string' ? proposal.prompt : '',
    background: typeof proposal.background === 'string' ? proposal.background : '',
    harness: word(proposal.harness),
    model: word(proposal.model),
    effort: word(proposal.effort),
    cwd: word(proposal.cwd),
    kind: proposal.kind === 'fork' ? 'fork' : 'fresh',
    wakeParent: proposal.wakeParent === true,
    offer: proposal.offer === true,
    status: lapsed ? 'expired' : proposal.status,
    createdAt: toMs(proposal.createdAt) ?? 0,
    expiresAt,
    settledAt: lapsed ? expiresAt : (toMs(proposal.settledAt) ?? null),
    startedId: word(proposal.startedThreadId),
    turnId: word(proposal.turnId),
    callId: word(proposal.callId),
    widerSandbox:
      typeof proposal.widerSandbox === 'string' && LEVELS.has(proposal.widerSandbox)
        ? (proposal.widerSandbox as SandboxLevel)
        : null,
  }
}

/** 一个会话上的提案（litch/sessionProposal/list 带 includeSettled 列出来的），先提的在前 */
export function projectProposals(
  list: readonly SessionProposal[] | null | undefined,
  now: number,
): SessionProposalView[] {
  const kept = (list ?? []).flatMap((proposal) => projectProposal(proposal, now) ?? [])
  return kept.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 提案变了的通知并进手上的那一份：changed 里的（任何状态）和 pending 里的（现在全部等着的）盖掉旧的；
 * 手上记着等着、通知里却既不在等着的里面也不在变了的里面的，不知道成了什么，拿掉（重新载入时再列出来）。
 * offer 卡的 offered、chosen 不按这一条拿：通知里“全部等着的”只保证有 pending 的，它们变了一定在 changed 里
 */
export function mergeProposals(
  current: readonly SessionProposalView[],
  pending: readonly SessionProposal[],
  changed: readonly SessionProposal[],
  now: number,
): SessionProposalView[] {
  const fresh = new Map<string, SessionProposalView>()
  for (const proposal of [...changed, ...pending]) {
    const view = projectProposal(proposal, now)
    if (view) fresh.set(view.id, view)
  }
  const merged = current.filter(
    (proposal) => !fresh.has(proposal.id) && proposal.status !== 'pending',
  )
  merged.push(...fresh.values())
  return merged.sort((a, b) => a.createdAt - b.createdAt)
}

/** 一句话描述最多这么多个字（取任务说明的第一句时） */
const DESCRIPTION_MAX = 40

/** 任务说明的第一句：第一行里到句号、问号、叹号为止，太长的截到 DESCRIPTION_MAX 个字 */
export function firstSentence(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ''
  const end = line.search(/[。！？!?]|\.(\s|$)/)
  const sentence = end > 0 ? line.slice(0, end) : line
  const chars = Array.from(sentence)
  return chars.length > DESCRIPTION_MAX ? `${chars.slice(0, DESCRIPTION_MAX).join('')}…` : sentence
}

/** 子代理线程的一个回合 → 它最近一个回合的样子 */
export function projectAgentTurn(turn: Turn): AgentTurnView {
  const startedAt = toMs(turn.startedAt)
  const completedAt = toMs(turn.completedAt)
  const state: AgentTurnView['state'] =
    turn.status === 'inProgress'
      ? 'running'
      : turn.status === 'failed'
        ? 'failed'
        : turn.status === 'interrupted'
          ? 'stopped'
          : 'completed'
  return {
    state,
    startedAt,
    durationMs:
      state === 'running'
        ? null
        : (turn.durationMs ??
          (startedAt !== null && completedAt !== null ? completedAt - startedAt : null)),
    error:
      state === 'failed' && typeof turn.error?.message === 'string' && turn.error.message
        ? turn.error.message
        : null,
  }
}

/**
 * 引擎自己的一个子代理线程：昵称、角色从会话对象上取，没有的再看它的来历；描述是它的名字，没有名字的取
 * 任务说明的第一句。turn 是它最近的一个回合（会话对象里带着回合的，没给就看最后一个）
 */
export function projectAgentThread(
  thread: Thread,
  turn: AgentTurnView | null = null,
): AgentThreadView {
  const spawn =
    typeof thread.source === 'object' &&
    thread.source !== null &&
    'subAgent' in thread.source &&
    typeof thread.source.subAgent === 'object' &&
    thread.source.subAgent !== null &&
    'thread_spawn' in thread.source.subAgent
      ? thread.source.subAgent.thread_spawn
      : null
  const prompt = (thread.preview ?? '').trim()
  const last = thread.turns?.at(-1)
  return {
    id: thread.id,
    parentId: parentOf(thread) ?? '',
    nickname: thread.agentNickname || spawn?.agent_nickname || null,
    role: thread.agentRole || spawn?.agent_role || null,
    description: thread.name?.trim() || firstSentence(prompt),
    prompt,
    status: sessionStatus(thread.status).status,
    turn: turn ?? (last ? projectAgentTurn(last) : null),
    canInput: typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null,
    updatedAt: toMs(thread.updatedAt) ?? 0,
  }
}

/**
 * 一个子代理现在算什么状态。按这个先后取第一个有的（不依赖 harness 回不回写派出它的那个条目）：
 * ① 子线程自己的：有回合在跑就是进行中，否则看它最近一个回合是完成、失败还是被打断；
 * ② 同一个父回合里协作条目（派出、等待、发输入、关闭……）最后报的它的状态（agentStatesOf）；
 * ③ 派出它的那个条目里的快照。
 * 都没有的（刚派出、对面还没说是谁）算排队
 */
export function agentRunState(
  thread: Pick<AgentThreadView, 'status' | 'turn'> | null | undefined,
  reported: AgentState | null | undefined,
  snapshot: AgentState | null | undefined,
): AgentRunState {
  if (thread) {
    if (thread.turn?.state === 'running' || thread.status === 'running') return 'running'
    if (thread.turn) return thread.turn.state
  }
  if (reported) return AGENT_RUN_STATE[reported]
  if (snapshot) return AGENT_RUN_STATE[snapshot]
  return 'queued'
}

/** 一个回合里各个子代理最后报的状态：按条目的先后，后面的盖掉前面的；没报状态的条目不算 */
export function agentStatesOf(items: readonly (ItemView | undefined)[]): Map<string, AgentState> {
  const states = new Map<string, AgentState>()
  for (const item of items) {
    if (item?.kind !== 'toolCall' || !item.agents) continue
    for (const agent of item.agents) if (agent.state) states.set(agent.threadId, agent.state)
  }
  return states
}

/** 这个条目是不是派出子代理的那一次调用（collab.spawnAgent） */
export const isAgentSpawn = (item: ItemView | undefined): boolean =>
  item?.kind === 'toolCall' &&
  item.agents !== undefined &&
  typeof item.tool === 'object' &&
  item.tool.key === 'collab.spawnAgent'

/**
 * 一个回合（按先后给出它的条目）里还有没有没做完的子代理：派出的子代理里有排队、进行中的，
 * 或者派出的那次调用还没结束、还不知道派了谁。threads 是父会话的子代理列表（keys.agents），
 * 没有的按条目里报的算。回合结束整段收起的判定用它：还有没做完的就不收
 */
export function agentsUnfinished(
  items: readonly (ItemView | undefined)[],
  threads: readonly AgentThreadView[] | null | undefined,
): boolean {
  const reported = agentStatesOf(items)
  for (const item of items) {
    if (!isAgentSpawn(item) || item?.kind !== 'toolCall') continue
    const agents = item.agents ?? []
    if (agents.length === 0) {
      if (item.status === 'inProgress') return true
      continue
    }
    for (const agent of agents) {
      const thread = threads?.find((entry) => entry.id === agent.threadId)
      if (!agentSettled(agentRunState(thread, reported.get(agent.threadId), agent.state)))
        return true
    }
  }
  return false
}
