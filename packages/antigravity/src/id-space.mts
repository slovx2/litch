import type { HarnessDeclaration } from '../../protocol/src/harness-capabilities.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

export type BackendId = 'sdk' | 'acp'
export const encodeThread = (backend: BackendId, id: string): string => `agy:${backend}:${id}`
export function decodeThread(id: unknown): { backend: BackendId; id: string } {
  if (typeof id !== 'string') throw new ProtocolError(-32602, '缺少 Antigravity 会话标识')
  const match = /^agy:(sdk|acp):(.+)$/.exec(id)
  if (!match) throw new ProtocolError(-32602, 'Antigravity 会话必须带 agy:sdk: 或 agy:acp: 前缀')
  return { backend: match[1] as BackendId, id: match[2] as string }
}
const single = new Set([
  'threadId',
  'parentThreadId',
  'forkedFromId',
  'sourceThreadId',
  'receiverThreadId',
])
const multiple = new Set(['threadIds', 'receiverThreadIds'])
export function threadReferences(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(threadReferences)
  return Object.entries(value).flatMap(([key, child]) =>
    single.has(key) && typeof child === 'string'
      ? [child]
      : multiple.has(key) && Array.isArray(child)
        ? child.filter((id): id is string => typeof id === 'string')
        : [],
  )
}
export function rewriteThreads(
  value: any,
  backend: BackendId,
  outward: boolean,
  declaration?: HarnessDeclaration,
): any {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value))
    return value.map((child) => rewriteThreads(child, backend, outward, declaration))
  // 只改协议的会话对象与字段，绝不改用户正文、工具 arguments 或自由 JSON 中看起来像 ID 的字符串。
  const thread =
    typeof value.id === 'string' &&
    typeof value.cwd === 'string' &&
    'createdAt' in value &&
    'turns' in value
  const convert = (id: string) => {
    if (outward) return encodeThread(backend, id)
    const decoded = decodeThread(id)
    if (decoded.backend !== backend)
      throw new ProtocolError(-32602, '不能跨 Antigravity 后端操作会话')
    return decoded.id
  }
  const result: any = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      (single.has(key) || (thread && ['id', 'sessionId'].includes(key))) &&
      typeof child === 'string'
    )
      result[key] = convert(child)
    else if (multiple.has(key) && Array.isArray(child))
      result[key] = child.map((id) => (typeof id === 'string' ? convert(id) : id))
    else if (
      ['thread', 'threadSettings', 'data', 'turn', 'turns', 'items', 'item', 'status'].includes(key)
    )
      result[key] = rewriteThreads(child, backend, outward, declaration)
    else result[key] = child
  }
  if (thread && outward) {
    if (declaration) result.litchCapabilities = value.litchCapabilities ?? declaration
    else delete result.litchCapabilities
  }
  return result
}
