// 双端的代答历史使用题目和答案，不向用户展示协议 JSON 或内部题号。
import type { SessionDelegatedResponse } from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

export function delegatedResponseText(
  record: SessionDelegatedResponse,
  t: (key: MessageKey) => string,
): string {
  const answer = record.answer as { answers?: Record<string, string[]>; decision?: unknown }
  if (record.kind === 'question')
    return (record.questions ?? [])
      .map((q) => `${q.question}\n${answer.answers?.[q.id]?.join('、') || t('ask.skipped')}`)
      .join('\n\n')
  const decision = answer.decision
  const label: MessageKey =
    decision === 'decline'
      ? 'request.option.decline'
      : decision === 'cancel'
        ? 'request.option.cancel'
        : decision === 'acceptForSession'
          ? 'request.option.acceptSession'
          : typeof decision === 'object' && decision !== null
            ? 'ask.approvalRecorded'
            : 'request.option.accept'
  return `${record.title}\n${t(label)}`
}
