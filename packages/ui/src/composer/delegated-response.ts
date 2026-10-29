// 双端的代答历史使用题目和答案，不向用户展示协议 JSON 或内部题号。
import type { SessionDelegatedResponse } from '@litch/core'
import type { MessageKey } from '../i18n/index.ts'

/** 一条代答记录拆成“问了什么 → 答了什么”：问题一题一对，审批是要批的事和选的那一项 */
export function delegatedPairs(
  record: SessionDelegatedResponse,
  t: (key: MessageKey) => string,
): { question: string; answer: string }[] {
  const answer = record.answer as { answers?: Record<string, string[]>; decision?: unknown }
  if (record.kind === 'question')
    return (record.questions ?? []).map((q) => ({
      question: q.question,
      answer: answer.answers?.[q.id]?.join('、') || t('ask.skipped'),
    }))
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
  return [{ question: record.title, answer: t(label) }]
}

export function delegatedResponseText(
  record: SessionDelegatedResponse,
  t: (key: MessageKey) => string,
): string {
  return delegatedPairs(record, t)
    .map((pair) => `${pair.question}\n${pair.answer}`)
    .join('\n\n')
}
