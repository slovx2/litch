// 与 C 的持久反馈意图采用同一形状；只有设备消费者调用。
import type { ExternalSubject } from '../../../protocol/src/external-sources.mjs'

export type GithubFeedbackAction =
  | { action: 'ack_comment_create'; text: string }
  | { action: 'ack_comment_update'; text: string; createKey: string }
  | {
      action: 'reaction_add'
      comment: { kind: 'comment' | 'review_comment'; id: string }
      reaction: 'eyes' | 'rocket'
    }
export type GithubFeedbackIntent = GithubFeedbackAction & {
  idempotencyKey: string
  sourceId: string
  managerId: string
  identityId: string
  botUserId: string
  subject: ExternalSubject
}

export function isGithubFeedbackAction(action: string): action is GithubFeedbackAction['action'] {
  return (
    action === 'ack_comment_create' || action === 'ack_comment_update' || action === 'reaction_add'
  )
}
