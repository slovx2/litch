// 提问答到一半的内容：各题填成了什么、翻到了第几题。只记在内存里（题目里可能有要保密的答案，
// 请求本身重开应用之后也就不在了）。离开详情页再进来、卡片重建，都从这里接着答；请求没了就清掉。
// 和桌面端 packages/ui/src/composer/question-drafts.ts 同一个做法。
import type { QuestionEntries } from '@litch/core'

export interface QuestionDraft {
  /** 翻到第几题，从 0 数 */
  page: number
  entries: QuestionEntries
}

/** 会话 → 请求标识 → 草稿 */
const drafts = new Map<string, Map<string, QuestionDraft>>()

const sessionOf = (deviceId: string, sessionId: string) => `${deviceId}\n${sessionId}`

export const loadQuestionDraft = (deviceId: string, sessionId: string, requestId: string) =>
  drafts.get(sessionOf(deviceId, sessionId))?.get(requestId)

export function saveQuestionDraft(
  deviceId: string,
  sessionId: string,
  requestId: string,
  draft: QuestionDraft,
): void {
  const key = sessionOf(deviceId, sessionId)
  const mine = drafts.get(key) ?? new Map<string, QuestionDraft>()
  mine.set(requestId, draft)
  drafts.set(key, mine)
}

/** 这个会话现在还等着的请求是这些：别的请求的草稿不留了。会话的内容到了之后才调 */
export function keepQuestionDrafts(deviceId: string, sessionId: string, pending: string[]): void {
  const key = sessionOf(deviceId, sessionId)
  const mine = drafts.get(key)
  if (!mine) return
  for (const requestId of [...mine.keys()]) {
    if (!pending.includes(requestId)) mine.delete(requestId)
  }
  if (mine.size === 0) drafts.delete(key)
}
