import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ProtocolError } from './protocol-contract.mjs'

export const permissionToolName = 'mcp__codex_harness_adapter_permissions__request_permissions'

export interface PermissionProfile {
  network?: { enabled: boolean | null }
  fileSystem?: { read: string[] | null; write: string[] | null }
}

export interface PermissionProposal {
  permissions: PermissionProfile
  reason: string | null
}

export interface PermissionGrant {
  permissions: PermissionProfile
  scope: 'turn' | 'session'
}

// 仅扩展当前执行边界；不修改原始 sandboxPolicy 或持久化配置。
export interface PermissionOverlay {
  writeRoots: string[]
  networkAccess: boolean
}

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, `${label} 必须是对象`)
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ProtocolError(-32602, `${label} 包含未知或尚不支持的字段`)
  return value as Record<string, unknown>
}

function paths(value: unknown): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new ProtocolError(-32602, '权限路径必须是数组')
  const result = value.map((path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
      throw new ProtocolError(-32602, '权限路径必须是绝对路径')
    try {
      // 不把尚不存在的单文件路径提升为可写父目录。
      return realpathSync(path)
    } catch {
      throw new ProtocolError(-32602, '权限路径必须已存在且可解析')
    }
  })
  return [...new Set(result)]
}

export function parsePermissionProfile(value: unknown): PermissionProfile {
  const raw = record(value, ['network', 'fileSystem'], '权限配置')
  const result: PermissionProfile = {}
  if (raw.network != null) {
    const network = record(raw.network, ['enabled'], '网络权限')
    if (network.enabled != null && typeof network.enabled !== 'boolean')
      throw new ProtocolError(-32602, 'network.enabled 必须是布尔值或 null')
    result.network = { enabled: (network.enabled as boolean | null | undefined) ?? null }
  }
  if (raw.fileSystem != null) {
    // entries/glob 需要独立的 OS 强制语义；不能接收后静默忽略。
    const files = record(raw.fileSystem, ['read', 'write'], '文件权限')
    result.fileSystem = { read: paths(files.read), write: paths(files.write) }
  }
  return result
}

export function parsePermissionProposal(value: unknown): PermissionProposal {
  const raw = record(value, ['permissions', 'reason'], '权限工具参数')
  if (raw.reason != null && typeof raw.reason !== 'string')
    throw new ProtocolError(-32602, '权限请求理由必须是字符串或 null')
  const permissions = parsePermissionProfile(raw.permissions)
  if (
    permissions.network?.enabled !== true &&
    !permissions.fileSystem?.read?.length &&
    !permissions.fileSystem?.write?.length
  )
    throw new ProtocolError(-32602, '权限提案必须请求明确的目录或网络权限')
  return { permissions, reason: (raw.reason as string | null | undefined) ?? null }
}

export function parsePermissionGrant(
  proposal: PermissionProposal,
  value: unknown,
): PermissionGrant {
  const raw = record(value, ['permissions', 'scope', 'strictAutoReview'], '权限答案')
  const scope = raw.scope === undefined ? 'turn' : raw.scope
  if (scope !== 'turn' && scope !== 'session')
    throw new ProtocolError(-32602, '权限作用域只能是 turn 或 session')
  if (raw.strictAutoReview != null && raw.strictAutoReview !== false)
    throw new ProtocolError(-32602, '暂不支持 strictAutoReview，未授予任何权限')
  const permissions = parsePermissionProfile(raw.permissions)
  const requested = proposal.permissions
  if (permissions.network?.enabled === true && requested.network?.enabled !== true)
    throw new ProtocolError(-32602, '网络授权超出权限提案')
  const readable = new Set([
    ...(requested.fileSystem?.read ?? []),
    ...(requested.fileSystem?.write ?? []),
  ])
  const writable = new Set(requested.fileSystem?.write ?? [])
  if (
    permissions.fileSystem?.read?.some((path) => !readable.has(path)) ||
    permissions.fileSystem?.write?.some((path) => !writable.has(path))
  )
    throw new ProtocolError(-32602, '目录授权超出权限提案')
  return { permissions, scope }
}

export function copyPermissionOverlay(value?: PermissionOverlay): PermissionOverlay {
  return {
    writeRoots: [...(value?.writeRoots ?? [])],
    networkAccess: value?.networkAccess === true,
  }
}

export function activePermissionRoots(value?: PermissionOverlay): string[] {
  return (value?.writeRoots ?? []).filter((root) => {
    try {
      return realpathSync(root) === root
    } catch {
      return false
    }
  })
}

export function mergePermissionOverlay(
  previous: PermissionOverlay | undefined,
  grant: PermissionGrant,
): PermissionOverlay {
  return {
    writeRoots: [
      ...new Set([...(previous?.writeRoots ?? []), ...(grant.permissions.fileSystem?.write ?? [])]),
    ],
    networkAccess: previous?.networkAccess === true || grant.permissions.network?.enabled === true,
  }
}
