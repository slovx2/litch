// ACP v1 的 elicitation 与 MCP 征询共用表单，保留布尔、数值、枚举等原始类型。
import type { ApprovalHost } from './approvals.mjs'
import { HandlerError } from './connection.mjs'
import type { LiveThread } from './server.mjs'

export async function elicit(
  host: ApprovalHost,
  live: LiveThread,
  params: any,
  name: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (params.mode !== 'form') throw new HandlerError(-32602, '此 ACP 连接仅声明 form elicitation')
  if (params.requestedSchema?.type !== 'object')
    throw new HandlerError(-32602, 'requestedSchema 必须为对象表单')
  const { projection } = live
  const id = projection.thread.id
  try {
    const reply = await projection.waiting(
      (method, value) => host.notify(id, method, value),
      () =>
        host.call(
          id,
          'mcpServer/elicitation/request',
          {
            serverName: name,
            turnId: projection.active?.id ?? null,
            mode: 'form',
            message: String(params.message ?? ''),
            requestedSchema: params.requestedSchema,
            _meta: null,
          },
          signal,
        ),
      'waitingOnUserInput',
    )
    if (!['accept', 'decline', 'cancel'].includes(reply?.action)) return { action: 'cancel' }
    return reply.action === 'accept'
      ? { action: 'accept', ...(reply.content == null ? {} : { content: reply.content }) }
      : { action: reply.action }
  } catch {
    return { action: 'cancel' }
  }
}
