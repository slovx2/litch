// 评论在界面里的几样共用的东西：订阅一个会话的评论草稿、变成随消息带的附带项、直接发出去一条。
import { type CoreChannel, MAX_COMMENTS, type MessageExtra } from '@litch/core'
import { useCallback, useSyncExternalStore } from 'react'
import {
  type DraftComment,
  editDraftComments,
  loadDraftComments,
  onDraftComments,
} from '../../composer/drafts.ts'

export { MAX_COMMENTS }

/** 一个会话（草稿的键是“设备:会话”）还没发出去的评论 */
export function useDraftComments(key: string): DraftComment[] {
  return useSyncExternalStore(
    onDraftComments,
    useCallback(() => loadDraftComments(key), [key]),
  )
}

/** 发出去时随消息带的那一项 */
export const commentExtra = (comment: DraftComment): MessageExtra => ({
  kind: 'comment',
  itemId: comment.itemId,
  quote: comment.quote,
  note: comment.note.trim(),
})

let seq = 0
export const newCommentId = (): string => `c${Date.now().toString(36)}${(++seq).toString(36)}`

export const addComment = (key: string, comment: DraftComment): void =>
  editDraftComments(key, (list) => [...list, comment].slice(0, MAX_COMMENTS))

export const updateComment = (key: string, id: string, note: string): void =>
  editDraftComments(key, (list) =>
    list.map((comment) => (comment.id === id ? { ...comment, note } : comment)),
  )

export const removeComment = (key: string, id: string): void =>
  editDraftComments(key, (list) => list.filter((comment) => comment.id !== id))

/** 只把这一条直接发出去：输入框里别的东西不动。回合在跑就照常排队（核心那边管） */
export const sendComment = (
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
  comment: DraftComment,
): Promise<unknown> =>
  channel.command('session.send', {
    deviceId,
    sessionId,
    text: '',
    images: [],
    extras: [commentExtra(comment)],
  })

/** 会话的键 */
export const commentKey = (deviceId: string, sessionId: string): string =>
  `${deviceId}:${sessionId}`
