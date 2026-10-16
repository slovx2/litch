import { ProtocolError, requiredString } from './protocol-contract.mjs'

export function experimentalFeatureList(
  params: Record<string, unknown>,
  isLoadedThread: (threadId: string) => boolean,
): { data: never[]; nextCursor: null } {
  if (
    params.limit != null &&
    (typeof params.limit !== 'number' ||
      !Number.isInteger(params.limit) ||
      params.limit < 0 ||
      params.limit > 4294967295)
  )
    throw new ProtocolError(-32602, 'limit 必须是 uint32 整数或 null')
  // 真实目录为空，从未发出下一页游标；不得忽略外来或伪造的游标。
  if (params.cursor != null) throw new ProtocolError(-32602, '实验功能游标无效或已失效')
  if (params.threadId != null) {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!isLoadedThread(threadId)) throw new ProtocolError(-32602, 'threadId 必须指向已加载会话')
  }
  return { data: [], nextCursor: null }
}

export function experimentalFeatureSet(params: Record<string, unknown>): {
  enablement: Record<string, boolean>
} {
  const enablement = params.enablement
  if (
    !Object.hasOwn(params, 'enablement') ||
    !enablement ||
    typeof enablement !== 'object' ||
    Array.isArray(enablement) ||
    Object.values(enablement).some((value) => typeof value !== 'boolean')
  )
    throw new ProtocolError(-32602, 'enablement 必须是布尔值映射')
  // 没有已实现的实验开关；完整校验后拒绝，不能回显成已应用设置。
  if (Object.keys(enablement).length)
    throw new ProtocolError(-32004, 'Claude 运行时尚未实现所请求的实验功能开关；未修改任何设置')
  return { enablement: {} }
}
