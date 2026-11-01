import { proposalStatus, proposedBy, type SessionProposalView } from '../model-tree.mjs'
// 问答卡的搜索内容与历史卡一致：答案并回题目，待答题在待答区搜索，不重复搜已隐藏的答复气泡。

import { wrapQuestionId } from '../../../protocol/src/pending-asks.mjs'
import type { ItemView } from '../model.mjs'
import { type AskAnswers, parseAskReply } from '../projection/asks.mjs'

export function searchCardItem(
  item: ItemView,
  answers: AskAnswers,
  pending: ReadonlySet<string>,
  known: ReadonlySet<string>,
): ItemView | null {
  if (item.kind === 'userMessage' && !item.peer && !item.system) {
    const replies = parseAskReply(item.text)
    if (
      replies &&
      item.attachments.length === 0 &&
      replies.every((reply) => known.has(reply.questionItemId))
    )
      return null
  }
  if (item.kind === 'agentMessage' && item.questions?.length)
    return {
      ...item,
      text: '',
      questions: item.questions
        .filter((q) => !pending.has(q.id))
        .map((q) => {
          const answer = answers[q.id]
          return answer === undefined ? q : { ...q, title: `${q.title}\n${answer}`, options: [] }
        }),
    }
  if (item.kind === 'toolCall' && item.wrapUp) {
    const id = wrapQuestionId(item.id, item.questionSource)
    const answer = answers[id]
    return {
      ...item,
      wrapUp: {
        ...item.wrapUp,
        ask: pending.has(id)
          ? ''
          : item.wrapUp.ask && answer !== undefined
            ? `${item.wrapUp.ask}\n${answer}`
            : (item.wrapUp.ask ?? ''),
        actions: pending.has(id) || answer !== undefined ? [] : (item.wrapUp.actions ?? []),
      },
    }
  }
  return item
}

/** 提案的标题/简报可能被用户改过；搜展示副本，不能继续搜调用时的旧参数。 */
export function searchProposalItem(
  item: ItemView,
  proposals: readonly SessionProposalView[],
  now: number,
): ItemView {
  if (item.kind !== 'toolCall') return item
  if (item.wrapUp)
    return {
      ...item,
      wrapUp: {
        ...item.wrapUp,
        suggestions: item.wrapUp.suggestions.map((seed) => {
          const proposal = proposals.find((p) => p.id === seed.proposalId)
          return proposal
            ? {
                ...seed,
                title: proposal.title,
                prompt: proposal.prompt,
                background: proposal.background,
              }
            : seed
        }),
      },
    }
  if (item.spawned) {
    const spawned = item.spawned
    const proposal = proposals.find((p) =>
      spawned.proposalId ? p.id === spawned.proposalId : p.offer && proposedBy(p, item.id),
    )
    if (!proposal) return item
    const status = proposalStatus(proposal, now)
    const brief = spawned.via !== 'offer' || status === 'pending' || status === 'started'
    return {
      ...item,
      spawned: {
        ...spawned,
        title: proposal.title,
        prompt: brief ? proposal.prompt : '',
        background: brief ? proposal.background : '',
      },
    }
  }
  return item
}
