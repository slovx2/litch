import { ProtocolError, type ThreadRuntimeSettings } from './protocol-contract.mjs'

// 省略保持，null 清空；先验证全部字段，避免一个无效字段留下部分更新。
export function patchGitInfo(
  current: ThreadRuntimeSettings['gitInfo'],
  patch: unknown,
): ThreadRuntimeSettings['gitInfo'] {
  if (patch === undefined) return current
  if (patch === null) return null
  if (typeof patch !== 'object' || Array.isArray(patch))
    throw new ProtocolError(-32602, 'gitInfo 必须是对象或 null')
  const next = { sha: null, branch: null, originUrl: null, ...current }
  for (const key of ['sha', 'branch', 'originUrl'] as const) {
    if (!Object.hasOwn(patch, key)) continue
    const value = (patch as Record<string, unknown>)[key]
    if (value !== null && (typeof value !== 'string' || value.trim().length === 0))
      throw new ProtocolError(-32602, `gitInfo.${key} 必须是非空字符串或 null`)
    next[key] = value as string | null
  }
  return next
}
