// 会话树（sessionTree 扩展）的投影：设备进程发来的提案、引擎自己的子代理线程 → 界面看到的样子。纯函数。
import type { SessionProposal, Thread } from '../../../protocol/src/index.mjs'
import type { AgentThreadView, SessionProposalView } from '../model-tree.mjs'
import { sessionStatus, threadTitle, toMs } from './session.mjs'

/**
 * 还等着用户点的提案。状态不是 pending 的、已经过了期的都不要（设备进程过期时会再发一次通知，
 * 这里先按时间筛掉，免得界面上留着一张点了也起不来的卡片）。对面给的形状不对的那一条不要
 */
export function projectProposals(
  list: readonly SessionProposal[] | null | undefined,
  now: number,
): SessionProposalView[] {
  const kept: SessionProposalView[] = []
  for (const proposal of list ?? []) {
    if (typeof proposal !== 'object' || proposal === null) continue
    if (proposal.status !== 'pending' || typeof proposal.id !== 'string') continue
    const expiresAt = toMs(proposal.expiresAt) ?? 0
    if (expiresAt <= now) continue
    kept.push({
      id: proposal.id,
      title: typeof proposal.title === 'string' ? proposal.title : '',
      prompt: typeof proposal.prompt === 'string' ? proposal.prompt : '',
      harness: typeof proposal.harness === 'string' && proposal.harness ? proposal.harness : null,
      model: typeof proposal.model === 'string' && proposal.model ? proposal.model : null,
      kind: proposal.kind === 'fork' ? 'fork' : 'fresh',
      wakeParent: proposal.wakeParent === true,
      createdAt: toMs(proposal.createdAt) ?? 0,
      expiresAt,
      widerSandbox:
        proposal.widerSandbox === 'read-only' ||
        proposal.widerSandbox === 'workspace-write' ||
        proposal.widerSandbox === 'danger-full-access'
          ? proposal.widerSandbox
          : null,
    })
  }
  return kept.sort((a, b) => a.createdAt - b.createdAt)
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
