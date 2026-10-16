import { ProtocolError } from './protocol-contract.mjs'
import type { NativeSessionFork } from './types.mjs'

export async function forkNativeSession(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  sessionId: string,
  cwd: string,
  upToMessageId?: string,
): Promise<NativeSessionFork> {
  const result = await sdk.forkSession(sessionId, {
    dir: cwd,
    ...(upToMessageId ? { upToMessageId } : {}),
  })
  const messageIds: Record<string, string> = {}
  // SDK 为分叉重新生成 UUID。通过公开导出 API 只读检查真实 forkedFrom，
  // 不按文本或顺序猜测，不修改原生 transcript，也不把临时快照作为持久化存储。
  await sdk.importSessionToStore(
    result.sessionId,
    {
      append: async (key, entries) => {
        if (key.sessionId !== result.sessionId)
          throw new ProtocolError(-32000, '分叉快照所属会话不匹配')
        for (const entry of entries) {
          const source = entry.forkedFrom as
            | { sessionId?: unknown; messageUuid?: unknown }
            | undefined
          if (
            source?.sessionId !== sessionId ||
            typeof source.messageUuid !== 'string' ||
            typeof entry.uuid !== 'string'
          )
            continue
          if (messageIds[source.messageUuid] && messageIds[source.messageUuid] !== entry.uuid)
            throw new ProtocolError(-32000, '原生分叉消息映射冲突')
          messageIds[source.messageUuid] = entry.uuid
        }
      },
      load: async () => {
        throw new Error('分叉检查只允许读取原生快照')
      },
    },
    { dir: cwd, includeSubagents: false },
  )
  if (upToMessageId && !messageIds[upToMessageId])
    throw new ProtocolError(-32000, '原生分叉缺少目标消息映射')
  return { sessionId: result.sessionId, messageIds }
}
