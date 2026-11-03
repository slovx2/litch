// 浏览器和 Computer Use 的注入只看会话所在设备的设置，不看创建者或当前执行端。
export const DEFAULT_TOOL_SWITCHES = { browser: true, computer: false } as const
export type ToolSwitches = { browser: boolean; computer: boolean }
export type ToolColumn = keyof ToolSwitches
export const TOOL_COLUMNS = ['browser', 'computer'] as const
export const MACHINE_SETTING = 'tools.machine'

export function deviceMachineEnabled(values: Record<string, unknown> | null | undefined): boolean {
  return values?.[MACHINE_SETTING] === true
}

export function toolSettingKey(column: ToolColumn, harness: string | null = null): string {
  return harness === null ? `tools.${column}` : `harness.${harness}.${column}`
}

export function deviceToolSwitches(
  values: Record<string, unknown> | null | undefined,
  harness: string | null,
): ToolSwitches {
  const value = (column: ToolColumn): boolean => {
    const own = harness === null ? undefined : values?.[toolSettingKey(column, harness)]
    const device = values?.[toolSettingKey(column)]
    return typeof own === 'boolean'
      ? own
      : typeof device === 'boolean'
        ? device
        : DEFAULT_TOOL_SWITCHES[column]
  }
  return { browser: value('browser'), computer: value('computer') }
}
