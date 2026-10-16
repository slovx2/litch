import { catalogPagination } from '../../shared/src/catalog-pagination.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import type { SessionStore } from './store.mjs'
import type { JsonValue } from './types.mjs'

export type ThreadAttachment = {
  id: string
  attachmentType: string
  identityKey: string
  payload: JsonValue
  createdAt: number
}

export type AttachmentUpdate = {
  threadId: string
  attachmentType: string
  identityKey: string
  attachmentId: string
  operation: 'created' | 'deleted'
}

export function threadAttachmentRequest(
  store: SessionStore,
  method: string,
  params: Record<string, unknown>,
  notify: (update: AttachmentUpdate) => void,
): unknown {
  const threadId = requiredString(params.threadId, 'threadId')
  if (!store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
  if (method === 'thread/attachment/list') {
    const page = catalogPagination(
      { limit: params.limit, cursor: params.cursor },
      `attachments:${threadId}`,
    )
    const entries = store.listAttachments(threadId, page.limit + 1, page.cursor)
    const data = entries.slice(0, page.limit)
    const last = data.at(-1)
    return {
      data,
      nextCursor: entries.length > page.limit && last ? page.encode(last.createdAt, last.id) : null,
    }
  }
  const attachmentType = requiredString(params.attachmentType, 'attachmentType')
  const identityKey = requiredString(params.identityKey, 'identityKey')
  if (method === 'thread/attachment/add') {
    // 入口来自 JSON-RPC，所有已存在的 JSON 值（包括 null）均是合法 payload。
    if (params.payload === undefined) throw new ProtocolError(-32602, 'payload 必须提供')
    const result = store.addAttachment(
      threadId,
      attachmentType,
      identityKey,
      params.payload as JsonValue,
    )
    if (result.outcome === 'created')
      notify({
        threadId,
        attachmentType,
        identityKey,
        attachmentId: result.attachment.id,
        operation: 'created',
      })
    return result
  }
  const attachmentId = store.removeAttachment(threadId, attachmentType, identityKey)
  if (attachmentId)
    notify({ threadId, attachmentType, identityKey, attachmentId, operation: 'deleted' })
  return {}
}
