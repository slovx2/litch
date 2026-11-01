// Litch 的供应商 × 模型自动压缩窗口。容量声明仍由供应商模块负责，不能用它替代压缩策略。
import { join } from 'node:path'
import { claudeManagedSettingsPath, contentHash, readJsonObject } from './claude-native-files.mjs'
import { settingLayerFiles } from './claude-setting-layers.mjs'
import { adapterHome } from './util.mjs'

export type ContextWindows = Record<string, Record<string, number>>
export const CONTEXT_WINDOWS_KEY = 'litch_context_windows'
export const AUTO_COMPACT_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

export function contextWindowsPath(): string {
  return join(adapterHome(), 'context-windows.json')
}

/** 目录的 resolvedModel 是 CLI 的权威身份。只去掉确定的变体，不猜别名当前指向哪个版本。 */
export function contextModelKey(model: string): string {
  const plain = model.trim().replace(/\[1m\]$/i, '')
  return plain.startsWith('claude-') ? plain.replace(/-\d{8}$/, '') : plain
}

export function readContextWindows(): ContextWindows {
  const raw = readJsonObject(contextWindowsPath()).value
  const result: ContextWindows = {}
  for (const [provider, entries] of Object.entries(raw)) {
    if (
      !/^[A-Za-z0-9_-]{1,32}$/.test(provider) ||
      ['__proto__', 'constructor', 'prototype'].includes(provider) ||
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries)
    )
      continue
    const windows: Record<string, number> = {}
    for (const [model, value] of Object.entries(entries)) {
      if (
        model &&
        !['__proto__', 'constructor', 'prototype'].includes(model) &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 100_000 &&
        value <= 1_000_000
      )
        windows[contextModelKey(model)] = value
    }
    result[provider] = windows
  }
  return result
}

export function contextWindowSettings(
  provider: string,
): Record<string, { autoCompactWindow: number }> {
  return Object.fromEntries(
    Object.entries(readContextWindows()[provider] ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, autoCompactWindow]) => [model, { autoCompactWindow }]),
  )
}

/** 作用域由实际 CLI 进程的启动快照提供，不能在结果到达时重新读取用户刚改的策略。 */
export function modelWindowCacheKey(scope: string, model: string): string {
  return JSON.stringify([scope, model])
}

/** 原生设置也会改变窗口；只对上下文相关字段取指纹，不把凭据写入缓存。 */
export function contextFilesScope(cwd: string): string {
  const names = [
    AUTO_COMPACT_ENV,
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
  ]
  const fields = (settings: Record<string, unknown>) => ({
    autoCompactWindow: settings.autoCompactWindow,
    autoCompactEnabled: settings.autoCompactEnabled,
    modelSettings: settings.modelSettings,
    env: Object.fromEntries(
      names.map((name) => [name, (settings.env as Record<string, unknown> | undefined)?.[name]]),
    ),
  })
  const layers = [
    ...settingLayerFiles(cwd).map((layer) => layer.path),
    claudeManagedSettingsPath(),
  ].map((path) => {
    try {
      return fields(readJsonObject(path).value)
    } catch {
      return null
    }
  })
  return contentHash(JSON.stringify([fields({ env: process.env }), layers]))
}
