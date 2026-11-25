// 无人值守的本机操作卡是会话里的待批准动作，不占用引擎请求或回合。
export const MACHINE_APPROVALS = 'machineApprovals'
export const MACHINE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
export const MACHINE_APPROVAL_MAX_PER_EXECUTOR = 32
export const MACHINE_APPROVAL_MAX_TEXT = 16 * 1024
export const MACHINE_TASK_PREFIX = 'machine-approval:'

export const MACHINE_APPROVAL_METHOD = {
  list: 'litch/machineApproval/list',
  open: 'litch/machineApproval/open',
  start: 'litch/machineApproval/start',
  finish: 'litch/machineApproval/finish',
  stop: 'litch/machineApproval/stop',
} as const

export const MACHINE_APPROVAL_NOTIFICATION = {
  changed: 'litch/machineApproval/changed',
  stop: 'litch/machineApproval/stopRequested',
} as const

export interface MachineApprovalCard {
  id: string
  threadId: string
  turnId: string | null
  action: 'exec' | 'read' | 'write' | 'list'
  /** 命令或展开的路径。手机仅浏览，完整冻结内容留在执行桌面。 */
  target: string
  cwd: string | null
  desktop: string
  expiresAt: number
}

export interface MachineApprovalKey {
  threadId: string
  id: string
}

export type MachineApprovalOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'rejected'
  | 'expired'
  | 'lost'

export interface MachineApprovalFinish extends MachineApprovalKey {
  outcome: MachineApprovalOutcome
  /** 受限的执行结果，供设备投递给发起会话。 */
  text?: string
}

export const isMachineApprovalId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
