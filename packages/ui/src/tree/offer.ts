// offer 卡（“新会话 / 在这里做”）的两样判断：对话里那次调用对上哪张提案，卡上写什么状态。
// 只有纯函数，卡片在 OfferCard.tsx。
import type { OfferChoice, ProposalStatus, SessionProposalView } from '@litch/core'

/**
 * 那次 litch_sessions.start（initiation offer）对上的提案：结果回来了按提案号找；
 * 调用还在等用户选（没有结果）时按提出它的调用（callId 就是这一条的条目 id）找
 */
export function findOffer(
  list: readonly SessionProposalView[] | undefined,
  itemId: string,
  proposalId: string | null,
): SessionProposalView | undefined {
  return list?.find((entry) =>
    proposalId ? entry.id === proposalId : entry.offer && entry.callId === itemId,
  )
}

/**
 * 卡上写的状态。有提案照提案（status 是 proposalStatus 现算的）；列表里没有（还没取到、对面没给）：
 * 侧栏里有从它开始的子会话就是开始了，再看调用结果里用户选了什么，调用失败了是 failed，都没有是 null（还在等）
 */
export function offerState(input: {
  status: ProposalStatus | null
  childId: string
  choice: OfferChoice | null
  failed: boolean
}): ProposalStatus | 'failed' | null {
  if (input.status) return input.status
  if (input.childId) return 'started'
  if (input.choice) return input.choice === 'session' ? 'chosen' : 'here'
  return input.failed ? 'failed' : null
}
