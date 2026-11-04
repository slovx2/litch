/** 待答题只在输入区作答；逐题留下已答、已忽略或已关闭的记录，多题部分作答时也不重复。 */
import type { AskAnswers, SessionQuestionSettlement } from '@litch/core'

/** 两端共用的记录显示；用户真实答复作摘要，经理处理经过仍可展开查看。 */
export function questionHistorySummary(
  questions: readonly { id: string }[],
  answers: AskAnswers,
  records: readonly SessionQuestionSettlement[],
  label: (action: 'answer' | 'withdraw') => string,
): string {
  return questions
    .map((question) => {
      const record = records.find((one) => one.replyIds.includes(question.id))
      return answers[question.id] ?? (record ? `${label(record.action)}: ${record.text}` : '')
    })
    .filter(Boolean)
    .join(' · ')
}

export function historyQuestions<T extends { id: string }>(
  questions: readonly T[],
  pending: readonly { replyIds: readonly string[] }[],
): T[] {
  const waiting = new Set(pending.flatMap((question) => question.replyIds))
  return questions.filter((question) => !waiting.has(question.id))
}
