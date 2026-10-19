// 会话树（sessionTree 扩展）的投影：设备进程发来的提案、引擎自己的子代理线程 → 界面看到的样子。纯函数。
import type { SessionProposal, Thread } from '../../../protocol/src/index.mjs'
import type {
  AgentThreadView,
  ProposalStatus,
  SandboxLevel,
  SessionProposalView,
} from '../model-tree.mjs'
import { sessionStatus, threadTitle, toMs } from './session.mjs'

const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>([
  'pending',
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
    harness: word(proposal.harness),
    model: word(proposal.model),
    cwd: word(proposal.cwd),
    kind: proposal.kind === 'fork' ? 'fork' : 'fresh',
    wakeParent: proposal.wakeParent === true,
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
 * 手上记着等着、通知里却既不在等着的里面也不在变了的里面的，不知道成了什么，拿掉（重新载入时再列出来）
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

/** 引擎自己的一个子代理线程：昵称、角色从会话对象上取，没有的再看它的来历 */
export function projectAgentThread(thread: Thread): AgentThreadView {
  const spawn =
    typeof thread.source === 'object' &&
    thread.source !== null &&
    'subAgent' in thread.source &&
    typeof thread.source.subAgent === 'object' &&
    thread.source.subAgent !== null &&
    'thread_spawn' in thread.source.subAgent
      ? thread.source.subAgent.thread_spawn
      : null
  const title = threadTitle(thread)
  return {
    id: thread.id,
    nickname: thread.agentNickname || spawn?.agent_nickname || null,
    role: thread.agentRole || spawn?.agent_role || null,
    title: typeof title === 'string' ? title : '',
    status: sessionStatus(thread.status).status,
    canInput: typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null,
    updatedAt: toMs(thread.updatedAt) ?? 0,
  }
}
