// 子会话的沙箱档：名字、和权限预设的对应、目标 harness 收不收得到父会话那么严。
// 提案卡片、手动派子会话和“改了再开始”的弹窗共用。
import type { SandboxLevel } from '@litch/core'

/** 沙箱档的名字（和三家内置的权限预设同名） */
export const SANDBOX_LEVEL = {
  'read-only': 'tree.level.readOnly',
  'workspace-write': 'tree.level.workspace',
  'danger-full-access': 'tree.level.full',
} as const

/** 弹窗里给人挑的顺序：从严到宽 */
export const SANDBOX_CHOICES: readonly SandboxLevel[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** 三家内置的权限预设对应的沙箱档 */
const PRESET_LEVEL: Record<string, SandboxLevel> = {
  ':danger-full-access': 'danger-full-access',
  ':workspace': 'workspace-write',
  ':read-only': 'read-only',
}
/** 越往后越严 */
const LEVEL_RANK: Record<SandboxLevel, number> = {
  'danger-full-access': 0,
  'workspace-write': 1,
  'read-only': 2,
}

/** 父会话的权限预设是哪一档沙箱。不是内置的那三档、还没取到是 null */
export const levelOf = (permission: string | null | undefined): SandboxLevel | null =>
  (permission && PRESET_LEVEL[permission]) || null

/**
 * 子会话想要 wanted 这一档（null 是跟父会话一样）时，目标 harness 给得到的每一档都比它宽：
 * 子会话实际会是的那一档（设备进程照同样的规矩算）。收得紧、或者认不出预设是 null
 */
export function widerLevel(
  parentPermission: string | null | undefined,
  targetPresets: readonly string[],
  wanted: SandboxLevel | null = null,
): SandboxLevel | null {
  const parent = levelOf(parentPermission)
  // 要的比父会话宽也会被收紧到父会话那一档
  const mine = wanted && (!parent || LEVEL_RANK[wanted] >= LEVEL_RANK[parent]) ? wanted : parent
  const levels = targetPresets.flatMap((id) => PRESET_LEVEL[id] ?? [])
  if (!mine || levels.length === 0) return null
  const best = levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a))
  return LEVEL_RANK[best] < LEVEL_RANK[mine] ? best : null
}
