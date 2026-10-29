// 执行设备上的无进展提醒，不改变原生回合状态或模型超时。只给声明 turnRecovery 的连接。
export const RECOVERY_READ = 'litch/device/recovery/read'
export const RECOVERY_CONTINUE = 'litch/device/recovery/continue'
export const RECOVERY_DISMISS = 'litch/device/recovery/dismiss'
export const RECOVERY_CHANGED = 'litch/turn/recovery/changed'

export interface TurnRecovery {
  reason: 'wake' | 'idle' | 'unresponsive'
  observedAt: number
  lastProgressAt: number
}
export interface RecoveryNotice {
  harness: string
  threadId: string
  turnId: string
  recovery: TurnRecovery | null
}
export interface SystemWake {
  supported: boolean
  generation: string
  sequence: number
  resumedAt: number
}
