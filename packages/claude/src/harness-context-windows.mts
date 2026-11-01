// 复用详情设置的数字行、覆盖来源与确认动作；桌面不用另读文件或重新实现 CLI 优先级。
import type {
  HarnessConfigReadResponse,
  HarnessSettingOption,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import { getAtPath, quoteKeySegment } from './claude-native-files.mjs'
import {
  ACCOUNT_PROVIDER,
  NATIVE_PROVIDER,
  readProviderConfig,
  splitModelRef,
} from './claude-provider.mjs'
import {
  AUTO_COMPACT_ENV,
  CONTEXT_WINDOWS_KEY,
  type ContextWindows,
  contextModelKey,
} from './context-windows.mjs'
import { text } from './harness-config-common.mjs'

export interface ContextModelOption {
  provider: string
  model: string
}

export function contextWindowRows(
  models: ContextModelOption[],
  options: HarnessSettingOption[],
  windows: ContextWindows,
): HarnessSettingSpec[] {
  const config = readProviderConfig()
  const entries = new Map<string, ContextModelOption>()
  const add = (provider: string, model: string) => {
    const key = contextModelKey(model)
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(provider)
    )
      return
    // 原生别名升级后会换模型；没有 resolvedModel 时不猜它的规范身份。
    if (!key || /^(default|best|opusplan|opus|sonnet|haiku|fable)$/.test(key)) return
    if (
      provider !== ACCOUNT_PROVIDER &&
      provider !== NATIVE_PROVIDER &&
      !config.providers[provider]
    )
      return
    entries.set(`${provider}\n${key}`, { provider, model: key })
  }
  for (const entry of models) add(entry.provider, entry.model)
  for (const option of options) {
    const ref = splitModelRef(option.value, config)
    add(ref.provider, ref.model)
  }
  for (const [provider, definition] of Object.entries(config.providers))
    for (const model of definition.models) add(provider, model.id)
  for (const [provider, rows] of Object.entries(windows))
    for (const model of Object.keys(rows)) add(provider, model)
  return [...entries.values()].map(({ provider, model }) => {
    const label =
      provider === ACCOUNT_PROVIDER
        ? text('官方账号', 'Account')
        : provider === NATIVE_PROVIDER
          ? text('Claude Code 原生配置', 'Claude Code settings')
          : text(
              config.providers[provider]?.title ?? provider,
              config.providers[provider]?.title ?? provider,
            )
    return {
      key: `${CONTEXT_WINDOWS_KEY}.${quoteKeySegment(provider)}.${quoteKeySegment(model)}`,
      group: 'context',
      type: 'integer',
      title: text(
        `[${label['zh-CN']}] ${model} 自动压缩窗口`,
        `[${label.en}] ${model} auto-compact window`,
      ),
      description: text(
        '仅此供应商。留空继承 Claude 设置；保存后在无后台任务的下一回合生效。',
        'For this provider. Unset inherits Claude settings; applies on the next turn without background tasks.',
      ),
      default: null,
      effect: 'none',
      minimum: 100_000,
      maximum: 1_000_000,
    }
  })
}

export function globalWindowOverride(
  settings: Record<string, unknown>,
  managed: Record<string, unknown>,
): { value: number; by: { 'zh-CN': string; en: string } } | null {
  for (const [raw, by] of [
    [
      getAtPath(managed, ['env', AUTO_COMPACT_ENV]),
      text('管理员 settings.json env', 'Managed settings env'),
    ],
    [
      getAtPath(settings, ['env', AUTO_COMPACT_ENV]),
      text('用户 settings.json env', 'User settings.json env'),
    ],
    [process.env[AUTO_COMPACT_ENV], text('设备启动环境', 'Device process environment')],
  ] as const) {
    if (typeof raw !== 'string' || !raw) continue
    const value = Number.parseInt(raw, 10)
    if (Number.isFinite(value) && value > 0)
      return { value: Math.max(100_000, Math.min(1_000_000, value)), by }
  }
  return null
}

export function windowOverrideActions(
  settings: Record<string, unknown>,
): HarnessConfigReadResponse['actions'] {
  const raw = getAtPath(settings, ['env', AUTO_COMPACT_ENV])
  if (typeof raw !== 'string' || !raw) return []
  const amount = Number(raw)
  const actions: HarnessConfigReadResponse['actions'] = [
    {
      id: 'context-window.clear-global',
      group: 'context',
      title: text('清除全局覆盖', 'Clear global override'),
      description: text(
        '只清除用户 settings.json env 中的自动压缩窗口。',
        'Removes only the auto-compact window from user settings.json env.',
      ),
      confirm: text(
        '清除全局覆盖后，按供应商与模型的窗口将优先生效。其他会话继承 Claude 设置。',
        'Remove the global override? Provider and model windows will take precedence; other sessions will inherit Claude settings.',
      ),
    },
  ]
  if (Number.isInteger(amount) && amount >= 100_000 && amount <= 1_000_000)
    actions.unshift({
      id: 'context-window.use-default',
      group: 'context',
      title: text('改为默认自动压缩窗口', 'Use as default auto-compact window'),
      description: text(
        `将 ${amount.toLocaleString('en-US')} 写入顶层 autoCompactWindow，并清除用户 env 覆盖。`,
        `Writes ${amount.toLocaleString('en-US')} to autoCompactWindow and removes the user env override.`,
      ),
      confirm: text(
        '将此全局覆盖改为默认值？现有默认值会被替换，按供应商与模型的设置可优先于默认值；其他环境或管理员覆盖仍可能生效。',
        'Convert this override to the default? The existing default will be replaced. Provider and model settings can override it; other environment or managed overrides may still apply.',
      ),
    })
  return actions
}
