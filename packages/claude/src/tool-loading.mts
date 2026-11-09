// CHA 工具加载策略。调用方的逐工具声明优先；未声明时才用可配置的命名空间默认值。
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

export const TOOL_LOADING_MODE = 'CHA_CLAUDE_TOOL_LOADING'
export const TOOL_LOADING_OVERRIDES = 'CHA_CLAUDE_TOOL_LOADING_OVERRIDES'
export const DEFAULT_DEFERRED_NAMESPACES = [
  'litch_browser',
  'litch_computer',
  'litch_tasks',
  'litch_repository',
  'litch_config',
] as const
export type LoadingMode = 'auto' | 'on' | 'off'
export type ToolLoading = (
  namespace: string | undefined,
  name: string,
  declaration?: {
    deferLoading?: unknown
    defer_loading?: unknown
  },
) => boolean

/** 两种字段同时存在时以规范的 camelCase 为准；不把字符串当作布尔。 */
export function declaredToolLoading(declaration?: {
  deferLoading?: unknown
  defer_loading?: unknown
}): boolean | undefined {
  if (typeof declaration?.deferLoading === 'boolean') return declaration.deferLoading
  if (typeof declaration?.defer_loading === 'boolean') return declaration.defer_loading
  return undefined
}

export function loadingOverrides(value: string | undefined): Map<string, boolean> {
  const result = new Map<string, boolean>()
  for (const entry of value?.split(',') ?? []) {
    if (!entry.trim()) continue
    const match = /^\s*([\w-]+(?:\.[\w-]+)?)\s*=\s*(always|defer)\s*$/.exec(entry)
    if (!match)
      throw new Error(
        `${TOOL_LOADING_OVERRIDES} 格式无效：请用 namespace=always 或 namespace.tool=defer，逗号分隔`,
      )
    const key = match[1]
    if (key) result.set(key, match[2] === 'defer')
  }
  return result
}

export function toolLoadingMode(env: NodeJS.ProcessEnv): LoadingMode {
  const mode = env[TOOL_LOADING_MODE]?.trim() || 'auto'
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off')
    throw new Error(`${TOOL_LOADING_MODE} 只能是 auto、on 或 off`)
  return mode
}

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
const enabledSearch = (value: string) =>
  value === 'true' || value === 'auto' || /^auto:(?:100|\d{1,2})$/.test(value)

/** auto 保守识别：已验证的 CLI、Claude 模型、官方端点或用户明确启用搜索。未知网关/云路由全部常驻。 */
export function toolSearchAvailable(
  version: string | null,
  env: NodeJS.ProcessEnv,
  model: string | null,
): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !isVersionAtLeast(version, '2.1.305'))
    return false
  if (truthy(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false
  if (
    ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) =>
      truthy(env[key]),
    )
  )
    return false
  const search = env.ENABLE_TOOL_SEARCH?.trim().toLowerCase() ?? ''
  if (search && !enabledSearch(search)) return false
  // 别名由 CLI 选它支持的默认代；其他模型/部署别名无法确认，留给 on 显式选择。
  const knownModel =
    /^(?:sonnet|opus|haiku)(?:\[1m\])?$/.test(model ?? '') ||
    /^claude-(?:sonnet-4|opus-4|haiku-4-5)(?:[-.\w]*)(?:\[1m\])?$/.test(model ?? '')
  if (!knownModel) return false
  if (search) return true
  if (!env.ANTHROPIC_BASE_URL?.trim()) return true
  try {
    return new URL(env.ANTHROPIC_BASE_URL).origin === 'https://api.anthropic.com'
  } catch {
    return false
  }
}

export function toolLoadingPolicy(
  version: string | null,
  env: NodeJS.ProcessEnv,
  model: string | null,
): ToolLoading {
  const mode = toolLoadingMode(env)
  const overrides = loadingOverrides(env[TOOL_LOADING_OVERRIDES])
  const enabled = mode === 'on' || (mode === 'auto' && toolSearchAvailable(version, env, model))
  return (namespace, name, declaration) => {
    // true/false 都是明确的逐工具选择；字符串等无效值不当作授权。
    const declared = declaredToolLoading(declaration)
    if (declared !== undefined) return declared
    if (!enabled) return false
    return (
      overrides.get(`${namespace ?? 'functions'}.${name}`) ??
      overrides.get(namespace ?? 'functions') ??
      DEFAULT_DEFERRED_NAMESPACES.some((value) => value === namespace)
    )
  }
}

export const toolLoadingMeta = (deferred: boolean) =>
  deferred ? {} : { _meta: { 'anthropic/alwaysLoad': true } }

/** 只列实际注册且按需的工具，不依赖 skill 是否安装；哈希 MCP 名称通过说明里的原始 namespace 检索。 */
export function deferredToolHint(tools: Array<{ namespace?: string; name: string }>): string {
  if (!tools.length) return ''
  const groups = [...new Set(tools.map((tool) => tool.namespace ?? 'functions'))]
  return `\n\n# Tools available on demand\nAdditional tools are available in: ${groups.join(', ')}. Use ToolSearch with the namespace and task keywords to load their definitions before calling them. If ToolSearch is unavailable, use the tools already provided. Browser and computer tools retain their skill/guide instructions and approval requirements.`
}
