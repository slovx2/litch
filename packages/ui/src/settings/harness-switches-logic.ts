// 设置页“按 harness 开关”那棵树（HarnessSwitches.tsx）和设备详情里那一行摘要要算的东西。
// 只存 harness 这一层：设备那一格是算出来的（全开、全关、有开有关）。
import type { DeviceView, HarnessSwitches } from '@litch/core'

export type SwitchColumn = 'taskCards' | 'browser' | 'computer'

export const SWITCH_COLUMNS: readonly SwitchColumn[] = ['taskCards', 'browser', 'computer']

/** 一格的样子。unknown：不知道（任务卡在设备上，设备没连着、没读到、旧设备服务没有这一项） */
export type CellState = 'on' | 'off' | 'mixed' | 'unknown'

export interface HarnessRow {
  id: string
  name: string
  switches: HarnessSwitches
}

/** 这台设备下面的各 harness，按设备声明的顺序 */
export function harnessRows(device: DeviceView): HarnessRow[] {
  const each = device.tools.harnesses ?? {}
  return device.harnesses.flatMap((entry) => {
    const switches = each[entry.id]
    return switches ? [{ id: entry.id, name: entry.name, switches }] : []
  })
}

export const harnessCell = (switches: HarnessSwitches, column: SwitchColumn): CellState => {
  const value = switches[column]
  return value === null ? 'unknown' : value ? 'on' : 'off'
}

/** 设备那一格：知道的那些 harness 全开、全关、有开有关。一个 harness 都没有时浏览器、Computer Use 看设备一级 */
export function deviceCell(device: DeviceView, column: SwitchColumn): CellState {
  const rows = harnessRows(device)
  if (rows.length === 0) {
    if (column === 'taskCards') return 'unknown'
    const value = device.tools[column]
    return value === null ? 'unknown' : value ? 'on' : 'off'
  }
  const known = rows.map((row) => harnessCell(row.switches, column)).filter((s) => s !== 'unknown')
  if (known.length === 0) return 'unknown'
  if (known.every((state) => state === 'on')) return 'on'
  return known.every((state) => state === 'off') ? 'off' : 'mixed'
}

/** 点设备那一格之后整列设成什么：全开的关掉，别的（全关、有开有关）都打开 */
export const nextForDevice = (state: CellState): boolean => state !== 'on'

/** 这一列出不出：浏览器、Computer Use 这台桌面执行不了时（DeviceView.tools 里是 null）不出 */
export const columnShown = (devices: readonly DeviceView[], column: SwitchColumn): boolean =>
  column === 'taskCards' || devices.some((device) => device.tools[column] !== null)

/**
 * 任务卡那一格改得了没有：存在设备上，要连着、读到了这一项。
 * 浏览器、Computer Use 存在桌面端，离线也改得了
 */
export const editable = (device: DeviceView, column: SwitchColumn, state: CellState): boolean =>
  column !== 'taskCards' || (device.connection === 'online' && state !== 'unknown')

/** 设备详情里一行摘要：全开、全关、只对哪几个开着；不知道是 null */
export type Summary = { kind: 'all' } | { kind: 'none' } | { kind: 'some'; names: string[] } | null

export function summaryOf(device: DeviceView, column: SwitchColumn): Summary {
  const state = deviceCell(device, column)
  if (state === 'unknown') return null
  if (state === 'on') return { kind: 'all' }
  if (state === 'off') return { kind: 'none' }
  return {
    kind: 'some',
    names: harnessRows(device)
      .filter((row) => row.switches[column] === true)
      .map((row) => row.name),
  }
}
