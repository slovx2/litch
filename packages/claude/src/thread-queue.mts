import { ProtocolError, pageRecords, requiredString, submissionHash } from './protocol-contract.mjs'
import type { SessionStore } from './store.mjs'
import type { UserInput } from './types.mjs'

function queueInput(value: unknown): UserInput[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => !part || typeof part !== 'object' || typeof part.type !== 'string')
  )
    throw new ProtocolError(-32602, '队列输入必须为非空用户输入数组')
  return value as UserInput[]
}

export function threadQueueRequest(
  store: SessionStore,
  method: string,
  params: Record<string, unknown>,
): { result: unknown; changed: boolean } {
  const threadId = requiredString(params.threadId, 'threadId')
  if (!store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
  const queue = store.queue
  if (method === 'thread/queue/list') {
    const entries = queue.list(threadId)
    const page = pageRecords(
      entries,
      { limit: params.limit, cursor: params.cursor, sortDirection: 'asc' },
      `queue:${threadId}:${submissionHash(entries.map((item) => item.id))}`,
      (item) => item.id,
    )
    return { result: { data: page.data, nextCursor: page.nextCursor }, changed: false }
  }
  if (method === 'thread/queue/add') {
    const { item, created } = queue.add(
      threadId,
      requiredString(params.clientUserMessageId, 'clientUserMessageId'),
      queueInput(params.input),
    )
    return { result: { queuedSubmission: item }, changed: created }
  }
  if (method === 'thread/queue/reorder') {
    if (
      !Array.isArray(params.queuedSubmissionIds) ||
      params.queuedSubmissionIds.some((id) => typeof id !== 'string')
    )
      throw new ProtocolError(-32602, 'queuedSubmissionIds 必须是字符串数组')
    queue.reorder(threadId, params.queuedSubmissionIds as string[])
    return { result: {}, changed: true }
  }
  const id = requiredString(params.queuedSubmissionId, 'queuedSubmissionId')
  if (method === 'thread/queue/update')
    return {
      result: { queuedSubmission: queue.update(threadId, id, queueInput(params.input)) },
      changed: true,
    }
  if (method === 'thread/queue/delete') {
    const deleted = queue.delete(threadId, id)
    return { result: { deleted }, changed: deleted }
  }
  throw new ProtocolError(-32601, '未知队列方法')
}
