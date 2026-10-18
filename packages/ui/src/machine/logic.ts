// 远程设备操作这台电脑的界面里不靠浏览器就能定的事：顶栏标记出不出、说什么，卡片上的命令要不要折，
// 自定义禁止位置的增删，操作记录的结果用什么颜色。界面测试直接引这个文件，所以只用可擦除的语法、只类型引用核心。
import type {
  MachineActivityView,
  MachineApproval,
  MachineLogEntry,
  MachinePendingView,
  MachineProcessView,
} from '@litch/core'

/** 顶栏标记要说的事。null：什么都没有，不显示 */
export interface MarkerFacts {
  running: number
  pending: number
  /** 起了这些进程的设备有几台（只有一台时说它的名字） */
  devices: string[]
  /** 设了“不确认”的设备（开着的才算）：一直标着 */
  never: string[]
}

/** 一台设备在“操作这台电脑”上的现状，标记只关心这两样 */
export interface MachineSwitch {
  deviceId: string
  enabled: boolean
  approval: MachineApproval
}

/**
 * 顶栏标记：有远程会话起的进程在跑、有待处理的卡片、有设备设了“不确认”，就出；都没有不出。
 * “不确认”那档设计里要求设置页和顶栏上一直标着（08 号 3.2）
 */
export function markerFacts(
  activity: MachineActivityView | undefined,
  switches: readonly MachineSwitch[],
): MarkerFacts | null {
  const running = activity?.running ?? []
  const pending = activity?.pending ?? []
  const never = switches
    .filter((entry) => entry.enabled && entry.approval === 'never')
    .map((entry) => entry.deviceId)
  if (running.length === 0 && pending.length === 0 && never.length === 0) return null
  const devices = [...new Set(running.map((entry) => entry.deviceId))]
  return { running: running.length, pending: pending.length, devices, never }
}

/** 弹层里的进程按设备分开、同一台里新的在前 */
export function byDevice(running: readonly MachineProcessView[]): MachineProcessView[][] {
  const groups = new Map<string, MachineProcessView[]>()
  for (const entry of running) {
    const list = groups.get(entry.deviceId) ?? []
    list.push(entry)
    groups.set(entry.deviceId, list)
  }
  return [...groups.values()].map((list) => [...list].sort((a, b) => b.startedAt - a.startedAt))
}

/** 待处理按快作废的在前 */
export const soonestFirst = (pending: readonly MachinePendingView[]): MachinePendingView[] =>
  [...pending].sort((a, b) => a.expiresAt - b.expiresAt)

/** 离作废还有多久，写成“分:秒”。过了就是 0:00 */
export function countdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const minutes = Math.floor(left / 60)
  const seconds = left % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 卡片上的命令超过这么多行、这么多字就先折起来，点了才展开 */
export const FOLD_LINES = 4
export const FOLD_CHARS = 280

/** 命令要不要折。返回一共几行：折的时候按钮上写出来 */
export function foldOf(command: string): { folded: boolean; lines: number } {
  const lines = command.split('\n').length
  return { folded: lines > FOLD_LINES || command.length > FOLD_CHARS, lines }
}

/** 加一条自定义的禁止位置。空的、已经在里面的不加，说明为什么 */
export function addPath(
  list: readonly string[],
  input: string,
): { list: string[] } | { problem: 'empty' | 'dup' } {
  const path = tidyPath(input)
  if (!path) return { problem: 'empty' }
  if (list.some((entry) => tidyPath(entry) === path)) return { problem: 'dup' }
  return { list: [...list, path] }
}

/** 去掉首尾空白和结尾多余的斜杠（根目录“/”留着） */
export function tidyPath(input: string): string {
  const trimmed = input.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') || '/' : trimmed
}

export const removePath = (list: readonly string[], path: string): string[] =>
  list.filter((entry) => entry !== path)

/** 操作记录的结果用哪种颜色：成了是 ok，拦下、拒绝、没人答、开关关着是 wait，出错是 err */
export function resultTone(result: MachineLogEntry['result']): 'ok' | 'wait' | 'err' {
  if (result === 'ok') return 'ok'
  if (result === 'failed') return 'err'
  return 'wait'
}
