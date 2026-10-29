// 判断这条用户消息是不是用户亲自发话。回报附带的正文是用户的话，纯回报、定时任务、
// 跨会话消息和后台自动回合的开头不是；自动回合中途的用户插话仍算。
import type { ItemView } from '../model.mjs'

export function isUserReply(
  item: ItemView | undefined,
  origin: string | undefined,
  index: number,
): boolean {
  if (item?.kind !== 'userMessage' || item.peer) return false
  if (item.system && item.system.kind !== 'here') return false
  if (index === 0 && origin && origin !== 'queue') return false
  return !!item.text.trim() || item.attachments.length > 0
}
