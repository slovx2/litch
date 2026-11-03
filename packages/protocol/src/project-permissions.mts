// 跨 harness 比较的是产品的访问档位，不表示各引擎的实际隔离能力相同。
export const PERMISSION_LEVELS = [':read-only', ':workspace', ':danger-full-access'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export function permissionLevel(value: unknown): PermissionLevel | null {
  return PERMISSION_LEVELS.find((entry) => entry === value) ?? null
}
export function permissionRank(value: unknown): number | null {
  const level = permissionLevel(value)
  return level === null ? null : PERMISSION_LEVELS.indexOf(level)
}
export const PROJECT_PERMISSION = {
  read: 'litch/projectPermission/read',
  set: 'litch/projectPermission/set',
  changed: 'litch/projectPermission/changed',
} as const
export interface ProjectPermission {
  /** 空字符串表示执行设备上的“无项目”新建范围。 */
  cwd: string
  permission: PermissionLevel | null
  confirmedPermissions: PermissionLevel[]
}
export interface ProjectPermissionSet {
  /** 实际目录或空字符串（无项目）；不按 harness 区分。 */
  cwd: string
  permission: PermissionLevel
  /** 用户本次明确确认；模型的工具调用不得写入项目确认。 */
  confirmed: boolean
}
export interface ProjectPermissionRequests {
  'litch/projectPermission/read': { params: { cwd: string }; result: ProjectPermission }
  'litch/projectPermission/set': { params: ProjectPermissionSet; result: ProjectPermission }
}
