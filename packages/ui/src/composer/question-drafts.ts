// 提问答到一半的内容：各题填成了什么、翻到了第几题。随改随记，只记在内存里。
// 切走会话再回来、卡片重建，都从这里接着答；请求没了（答了、别处答了、回合结束）就清掉。
// 不往本地存储里放：题目里可能有要保密的答案，而且请求本身重开应用之后就不在了。
import type { QuestionEntries } from '@litch/core'

export interface QuestionDraft {
  /** 翻到第几题，从 0 数 */
  page: number
  entries: QuestionEntries
}

/** 会话 → 请求标识 → 草稿 */
const drafts = new Map<string, Map<string, QuestionDraft>>()

const sessionOf = (deviceId: string, sessionId: string) => `${deviceId}\n${sessionId}`

export interface DraftRef {
  deviceId: string
  sessionId: string
  requestId: string
}

export const loadQuestionDraft = ({ deviceId, sessionId, requestId }: DraftRef) =>
  drafts.get(sessionOf(deviceId, sessionId))?.get(requestId)

export function saveQuestionDraft(ref: DraftRef, draft: QuestionDraft): void {
  const key = sessionOf(ref.deviceId, ref.sessionId)
  const mine = drafts.get(key) ?? new Map<string, QuestionDraft>()
  mine.set(ref.requestId, draft)
  drafts.set(key, mine)
}

/**
 * 这个会话现在还等着的请求是这些：别的请求的草稿不留了。
 * 只在会话的内容到了之后调——还没载入的时候请求列表是空的，那不是“请求都没了”
 */
export function keepQuestionDrafts(deviceId: string, sessionId: string, pending: string[]): void {
  const key = sessionOf(deviceId, sessionId)
  const mine = drafts.get(key)
  if (!mine) return
  for (const requestId of [...mine.keys()]) {
    if (!pending.includes(requestId)) mine.delete(requestId)
  }
  if (mine.size === 0) drafts.delete(key)
}
