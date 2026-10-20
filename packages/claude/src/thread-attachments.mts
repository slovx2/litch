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

// thread/attachmentOwner/list（0.163.0 起）：按附件身份反查会话，只看本入口的库。
// archived 省略或为 null 时全给，false 只给没归档的，true 只给归档的；页大小默认 25、钳在 1 到 100（都照上游）。
export function threadAttachmentOwnerList(
  store: SessionStore,
  params: Record<string, unknown>,
): unknown {
  const attachmentType = requiredString(params.attachmentType, 'attachmentType')
  const identityKey = requiredString(params.identityKey, 'identityKey')
  if (params.archived != null && typeof params.archived !== 'boolean')
    throw new ProtocolError(-32602, 'archived 必须是布尔值')
  const archived = (params.archived as boolean | null | undefined) ?? null
  const requested = params.limit ?? 25
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0)
    throw new ProtocolError(-32602, 'limit 必须是非负整数')
  const limit = Math.min(Math.max(requested, 1), 100)
  // 游标只认同一组查询条件：身份和归档筛选都算在内
  const page = catalogPagination(
    { cursor: params.cursor },
    `attachmentOwners:${JSON.stringify([attachmentType, identityKey, archived])}`,
  )
  const rows = store.listAttachmentOwners(
    attachmentType,
    identityKey,
    archived,
    limit + 1,
    page.cursor,
  )
  const data = rows.slice(0, limit)
  const last = data.at(-1)
  return {
    data: data.map((row) => ({ threadId: row.threadId, archived: row.archived })),
    nextCursor: rows.length > limit && last ? page.encode(last.createdAt, last.id) : null,
  }
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
