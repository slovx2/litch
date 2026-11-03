// 只比较三档访问权限，实际工具和沙箱语义由目标引擎负责。未知权限不能当作默认放行。
import {
  PERMISSION_LEVELS,
  permissionLevel,
  permissionRank,
} from '../../protocol/src/project-permissions.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { EngineLink } from './engine-link.mjs'
import { isObject } from './wire.mjs'

export function currentPermission(config: Record<string, unknown> | null): string | null {
  const profile = config?.activePermissionProfile
  const named = typeof profile === 'string' ? profile : isObject(profile) ? profile.id : null
  if (typeof named === 'string' && named) return named
  const sandbox = config?.sandbox
  const type = isObject(sandbox) ? sandbox.type : sandbox
  if (type === 'readOnly' || type === 'read-only') return ':read-only'
  if (type === 'workspaceWrite' || type === 'workspace-write') return ':workspace'
  if (type === 'dangerFullAccess' || type === 'danger-full-access') return ':danger-full-access'
  return null
}
export function supportedPermissions(link: Pick<EngineLink, 'native' | 'runtime'>): string[] {
  if (link.native) return [...PERMISSION_LEVELS]
  const presets = link.runtime?.permissionPresets
  return Array.isArray(presets)
    ? presets.flatMap((preset) =>
        isObject(preset) && typeof preset.id === 'string' ? [preset.id] : [],
      )
    : []
}
export function requireSupportedPermission(
  link: Pick<EngineLink, 'native' | 'runtime'>,
  permission: string,
): void {
  if (!permissionLevel(permission) || !supportedPermissions(link).includes(permission))
    throw new ProtocolError(
      -32602,
      `Target harness does not support permission ${permission}. Choose a supported permission or another harness.`,
    )
}
/** 只接受引擎显式声明免确认；原生 Codex 与未声明时仍保留完全访问确认。 */
export function requiresPermissionConfirmation(
  link: Pick<EngineLink, 'native' | 'runtime'>,
  permission: string,
): boolean {
  if (permission !== ':danger-full-access') return false
  if (link.native) return true
  const presets = link.runtime?.permissionPresets
  const preset = Array.isArray(presets)
    ? presets.find((entry) => isObject(entry) && entry.id === permission)
    : null
  return !isObject(preset) || preset.requiresConfirmation !== false
}
export function childPermissions(
  parent: Record<string, unknown> | null,
  requested: {
    permission?: string | null | undefined
    sandbox?: unknown
    approvalPolicy?: unknown
  },
  link: Pick<EngineLink, 'native' | 'runtime'>,
): { permissions: string; approvalPolicy?: unknown } {
  const inherited = currentPermission(parent)
  const parentRank = permissionRank(inherited)
  if (parentRank === null)
    throw new ProtocolError(
      -32602,
      'Cannot compare the parent permission. Select a built-in permission before starting a sub-session.',
    )
  const sandbox =
    requested.sandbox == null ? null : currentPermission({ sandbox: requested.sandbox })
  if (requested.sandbox != null && !sandbox)
    throw new ProtocolError(-32602, 'Unknown sandbox permission.')
  if (requested.permission && sandbox && requested.permission !== sandbox)
    throw new ProtocolError(-32602, 'permission and sandbox conflict.')
  const permission = (requested.permission ?? sandbox ?? inherited) as string
  const rank = permissionRank(permission)
  if (rank === null || rank > parentRank)
    throw new ProtocolError(
      -32602,
      `Sub-session permission ${permission} exceeds or cannot be compared with parent permission ${inherited}.`,
    )
  requireSupportedPermission(link, permission)
  const approvalRank = (value: unknown): number | null => {
    if (value === 'never') return 0
    if (value === 'on-request' || value === 'on-failure') return 1
    if (isObject(value) && isObject(value.granular)) return 1
    return value === 'untrusted' ? 2 : null
  }
  if (
    requested.approvalPolicy != null &&
    (isObject(requested.approvalPolicy) || isObject(parent?.approvalPolicy)) &&
    JSON.stringify(requested.approvalPolicy) !== JSON.stringify(parent?.approvalPolicy)
  )
    throw new ProtocolError(-32602, 'Custom approval policies must be inherited unchanged.')
  const mine = approvalRank(parent?.approvalPolicy)
  const asked = approvalRank(requested.approvalPolicy)
  if (requested.approvalPolicy != null && (asked === null || mine === null || asked < mine))
    throw new ProtocolError(
      -32602,
      'Sub-session approval policy must not be wider than the parent policy.',
    )
  // 保留已有更严的审批要求；权限预设本身交给引擎解析。
  const approvalPolicy = requested.approvalPolicy ?? parent?.approvalPolicy
  return { permissions: permission, ...(approvalPolicy == null ? {} : { approvalPolicy }) }
}
