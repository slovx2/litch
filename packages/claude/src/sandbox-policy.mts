import { isAbsolute } from 'node:path'
import { ProtocolError } from './protocol-contract.mjs'

export type RuntimeSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export function parseSandboxPolicy(value: unknown): RuntimeSandboxPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, 'sandboxPolicy 必须是对象')
  const policy = value as Record<string, unknown>
  if (policy.type === 'dangerFullAccess') return { type: 'dangerFullAccess' }
  if (policy.type !== 'readOnly' && policy.type !== 'workspaceWrite')
    throw new ProtocolError(-32602, '不支持此 sandboxPolicy')
  for (const key of ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'])
    if (Object.hasOwn(policy, key) && typeof policy[key] !== 'boolean')
      throw new ProtocolError(-32602, key + ' 必须是布尔值')
  if (policy.type === 'readOnly')
    return { type: 'readOnly', networkAccess: policy.networkAccess === true }
  if (
    Object.hasOwn(policy, 'writableRoots') &&
    (!Array.isArray(policy.writableRoots) ||
      policy.writableRoots.some(
        (root) => typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'),
      ))
  )
    throw new ProtocolError(-32602, 'writableRoots 必须是绝对路径数组')
  return {
    type: 'workspaceWrite',
    writableRoots: [...new Set((policy.writableRoots as string[] | undefined) ?? [])],
    networkAccess: policy.networkAccess === true,
    excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar === true,
    excludeSlashTmp: policy.excludeSlashTmp === true,
  }
}

export function sandboxPolicyMode(policy: RuntimeSandboxPolicy): string {
  return policy.type === 'dangerFullAccess'
    ? 'danger-full-access'
    : policy.type === 'readOnly'
      ? 'read-only'
      : 'workspace-write'
}

export function defaultSandboxPolicy(mode: string | null, cwd: string): RuntimeSandboxPolicy {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

export function policyFromParams(
  params: Record<string, unknown>,
  cwd: string,
  fallback: RuntimeSandboxPolicy,
): RuntimeSandboxPolicy {
  const profiles: Record<string, string> = {
    ':danger-full-access': 'danger-full-access',
    ':workspace': 'workspace-write',
    ':read-only': 'read-only',
  }
  const profile = typeof params.permissions === 'string' ? profiles[params.permissions] : undefined
  if (profile) return defaultSandboxPolicy(profile, cwd)
  if (params.sandboxPolicy != null) return parseSandboxPolicy(params.sandboxPolicy)
  if (typeof params.sandbox === 'string') return defaultSandboxPolicy(params.sandbox, cwd)
  return fallback
}
