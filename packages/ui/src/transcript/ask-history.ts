/** 待答题只在输入区作答；逐题留下已答、已忽略或已关闭的记录，多题部分作答时也不重复。 */
export function historyQuestions<T extends { id: string }>(
  questions: readonly T[],
  pending: readonly { replyIds: readonly string[] }[],
): T[] {
  const waiting = new Set(pending.flatMap((question) => question.replyIds))
  return questions.filter((question) => !waiting.has(question.id))
}
