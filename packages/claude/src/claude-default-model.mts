// 默认模型和推理强度以 Claude Code 自己的 settings.json 为准（`model`、`effortLevel`），和设备上的命令行共用。
// 以前适配器把它们记在自己的 config.json 顶层（`model`、`model_reasoning_effort`）：第一次读到旧值时
// 写进 settings.json（那边已经有值的不覆盖），再从 config.json 里去掉，之后只认 settings.json。

import { claudeSettingsPath, readJsonObject, writeJsonObject } from './claude-native-files.mjs'
import { readConfigFile, writeConfigFile } from './config-store.mjs'
import { normalizeCodexReasoningEffort } from './util.mjs'

export type SettingsEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface SettingsDefaults {
  model: string | null
  effort: SettingsEffort | null
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

/** 读 settings.json 里的默认模型与强度。文件坏了按没写处理（不能因为它起不来） */
export function readSettingsDefaults(path = claudeSettingsPath()): SettingsDefaults {
  try {
    const { value } = readJsonObject(path)
    return {
      model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : null,
      effort:
        typeof value.effortLevel === 'string' && EFFORTS.has(value.effortLevel)
          ? (value.effortLevel as SettingsEffort)
          : null,
    }
  } catch {
    return { model: null, effort: null }
  }
}

/**
 * 客户端选的模型写进 settings.json 时的写法：“默认”就是不写（交给 CLI 自己的默认），其余原样。
 * 客户端的目录行本来就是 CLI 的别名或完整型号（model/list 取自 CLI 的 supportedModels）。
 */
export function settingsModelValue(model: string | null): string | null {
  if (model == null) return null
  const trimmed = model.trim()
  if (!trimmed || trimmed === 'default' || trimmed === 'claude-default') return null
  return trimmed
}

/** 改 settings.json 里的默认模型与强度；undefined 表示这一项不动，null 表示删掉 */
export function writeSettingsDefaults(
  edits: { model?: string | null; effort?: string | null },
  path = claudeSettingsPath(),
): void {
  const { value } = readJsonObject(path)
  const next = { ...value }
  if (edits.model !== undefined) {
    const model = settingsModelValue(edits.model)
    if (model === null) delete next.model
    else next.model = model
  }
  if (edits.effort !== undefined) {
    const effort = edits.effort == null ? null : normalizeCodexReasoningEffort(edits.effort)
    if (effort === null) delete next.effortLevel
    else next.effortLevel = effort
  }
  if (JSON.stringify(next) === JSON.stringify(value)) return
  writeJsonObject(path, next)
}

/**
 * 把 config.json 里的旧默认值搬到 settings.json。返回搬了没有。
 * 调用方先校验过 config.json（无效的旧模型照旧让服务起不来，不搬）。
 */
export function migrateDefaultModel(
  configPath: string,
  settingsPath = claudeSettingsPath(),
): boolean {
  const { values } = readConfigFile(configPath)
  const hasModel = Object.hasOwn(values, 'model')
  const hasEffort = Object.hasOwn(values, 'model_reasoning_effort')
  if (!hasModel && !hasEffort) return false
  const current = readJsonObject(settingsPath).value
  writeSettingsDefaults(
    {
      ...(hasModel && current.model === undefined ? { model: values.model as string | null } : {}),
      ...(hasEffort && current.effortLevel === undefined
        ? { effort: values.model_reasoning_effort as string | null }
        : {}),
    },
    settingsPath,
  )
  const { model: _model, model_reasoning_effort: _effort, ...rest } = values
  writeConfigFile(configPath, rest, null)
  return true
}
