import {
  MACHINE_SETTING,
  TOOL_COLUMNS,
  toolSettingKey,
} from '../../../protocol/src/client-tools-settings.mjs'
import type {
  DeviceSettingsReadResponse,
  DeviceSettingsWriteParams,
  DeviceSettingsWriteResponse,
  SettingEdit,
} from '../../../protocol/src/device-settings.mjs'
import type { SavedToolSwitches, ToolSwitchChange } from './remote.mjs'

/**
 * 0.30 将开关权威从桌面移到设备。仅迁移设备未显式设置的整列，避免把已开启的 CU 恢复成默认关闭。
 * 写入成功或设备已有值之后才清本地；版本冲突保留本地，下次重连重新读，不覆盖另一客户端的选择。
 */
export async function migrateToolSettings(
  current: DeviceSettingsReadResponse,
  legacy: SavedToolSwitches | undefined,
  write: (params: DeviceSettingsWriteParams) => Promise<DeviceSettingsWriteResponse>,
  clear: () => void,
): Promise<DeviceSettingsReadResponse> {
  if (!legacy || !current.schema.settings.some((spec) => spec.key === toolSettingKey('browser')))
    return current
  const known = new Set(current.schema.settings.map((spec) => spec.key))
  const explicit = new Set(current.snapshot.explicit)
  const edits: SettingEdit[] = []
  if (
    known.has(MACHINE_SETTING) &&
    !explicit.has(MACHINE_SETTING) &&
    typeof legacy.machine === 'boolean'
  )
    edits.push({ key: MACHINE_SETTING, value: legacy.machine })
  for (const column of TOOL_COLUMNS) {
    const base = toolSettingKey(column)
    if (
      [...explicit].some(
        (key) => key === base || (/^harness\.[^.]+\./.test(key) && key.endsWith(`.${column}`)),
      )
    )
      continue
    if (typeof legacy[column] === 'boolean') edits.push({ key: base, value: legacy[column] })
    for (const [harness, saved] of Object.entries(legacy.harnesses ?? {})) {
      const key = toolSettingKey(column, harness)
      if (known.has(key) && typeof saved[column] === 'boolean')
        edits.push({ key, value: saved[column] })
    }
  }
  const snapshot = edits.length
    ? (await write({ expectedVersion: current.snapshot.version, edits })).snapshot
    : current.snapshot
  clear()
  return { ...current, snapshot }
}

export function toolSettingEdits(
  current: DeviceSettingsReadResponse,
  change: ToolSwitchChange,
): SettingEdit[] {
  const edits: SettingEdit[] = []
  if (typeof change.machine === 'boolean') {
    if (!current.schema.settings.some((spec) => spec.key === MACHINE_SETTING))
      throw new Error(`设备未声明设置 ${MACHINE_SETTING}`)
    edits.push({ key: MACHINE_SETTING, value: change.machine })
  }
  for (const column of TOOL_COLUMNS) {
    if (typeof change[column] !== 'boolean') continue
    const key = toolSettingKey(column, change.harness ?? null)
    if (!current.schema.settings.some((spec) => spec.key === key))
      throw new Error(`设备未声明设置 ${key}`)
    edits.push({ key, value: change[column] })
    if (change.harness === undefined)
      for (const key of current.snapshot.explicit)
        if (/^harness\.[^.]+\./.test(key) && key.endsWith(`.${column}`))
          edits.push({ key, value: null })
  }
  return edits
}
