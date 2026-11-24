/** 经理设备设置和 Claude 内部压缩入口共用的形状。 */
export const MANAGER_IDLE_COMPACT_EXTENSION = 'litchManagerIdleCompact'
export const IDLE_COMPACT_READ = 'litch/thread/idleCompact/read'

export interface ManagerIdleCompactSettings {
  enabled: boolean
  idleMinutes: number
  contextPercent: number
}

/**
 * 引擎有带条件的压缩入口（idleCompact/read、thread/compact/start 带快照）的 harness。
 * 设置对所有经理开放；经理本身只在这些 harness 上压缩，子会话也只压这些 harness 的。
 */
export const IDLE_COMPACT_HARNESSES: readonly string[] = ['claude-code', 'pi']
export const idleCompactSupports = (harness: string): boolean =>
  IDLE_COMPACT_HARNESSES.includes(harness)

export const DEFAULT_MANAGER_IDLE_COMPACT: ManagerIdleCompactSettings = {
  enabled: true,
  idleMinutes: 50,
  contextPercent: 70,
}

export const IDLE_COMPACT_MINUTES = { min: 5, max: 55 } as const
export const IDLE_COMPACT_PERCENT = { min: 1, max: 99 } as const

export function idleCompactInteger(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= range.min &&
    value <= range.max
  )
}

/** at 为毫秒；占用是百分比，after=null 表示引擎没报告压缩后用量。 */
export interface ManagerIdleCompactRecord {
  at: number
  before: number
  after: number | null
}

export interface IdleCompactSnapshot {
  idle: boolean
  /** 独立的 /compact 不开始新的工作周期。 */
  lastTurnId: string | null
  /** 普通回合开始或结束（取较晚），Unix 毫秒。 */
  lastTurnActivityAt: number | null
  usageTurnId: string | null
  usedTokens: number | null
  windowTokens: number | null
}

export const managerInputMethod = (method: string) =>
  method === 'turn/start' ||
  method === 'turn/steer' ||
  method === 'thread/queue/add' ||
  method === 'thread/queue/start'
