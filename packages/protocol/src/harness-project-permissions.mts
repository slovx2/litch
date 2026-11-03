// 权限记忆按执行设备、真实目录和 harness 独立保存；旧跨 harness 协议不复用。
import type { PermissionLevel } from './project-permissions.mjs'

export {
  PERMISSION_LEVELS,
  type PermissionLevel,
  permissionLevel,
  permissionRank,
} from './project-permissions.mjs'

export const PROJECT_PERMISSION = {
  read: 'litch/harnessProjectPermission/read',
  set: 'litch/harnessProjectPermission/set',
  changed: 'litch/harnessProjectPermission/changed',
} as const
export interface ProjectPermissionScope {
  /** 实际目录；空字符串表示该设备、该 harness 的“无项目”范围。 */
  cwd: string
  harness: string
}
export interface ProjectPermission extends ProjectPermissionScope {
  permission: PermissionLevel | null
  confirmedPermissions: PermissionLevel[]
}
export interface ProjectPermissionSet extends ProjectPermissionScope {
  permission: PermissionLevel
  /** 用户本次明确确认；引擎默认和模型调用不能伪造确认。 */
  confirmed: boolean
}
export interface ProjectPermissionRequests {
  'litch/harnessProjectPermission/read': {
    params: ProjectPermissionScope
    result: ProjectPermission
  }
  'litch/harnessProjectPermission/set': { params: ProjectPermissionSet; result: ProjectPermission }
}
