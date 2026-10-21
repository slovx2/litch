// 上下文占用的口径（客户端画的那个用量环）：
// - 占用取最近一次模型请求的用量：输入、缓存读、缓存写、输出加起来，就是下一次请求时上下文里有多少。
//   SDK 结果里的 usage 是整个回合主循环所有请求的累加，一个回合调十次工具，缓存读就算了十遍，不能用。
// - 主会话和每个子代理各算各的（按 parent_tool_use_id 分路），子代理的请求不改主会话的占用。
// - 同一次请求的用量会分几次来：流式的开头、结尾，以及按内容块拆开的几条助手消息。按 message.id 合在一起，各项取最大的。
// - 窗口大小先取 CLI 自己 /context 用的那个：解析后的自动压缩窗口（getContextUsage 的 rawMaxTokens），
//   用户设了 CLAUDE_CODE_AUTO_COMPACT_WINDOW、autoCompactWindow 时比模型窗口小；
//   取不到时退回结果里 modelUsage[主模型].contextWindow，主模型是最近一次顶层请求的模型。

export interface RequestUsage {
  id: string
  usage: Record<string, number>
  // 上次报出去的占用，没变就不再报
  reported: number
}

/** 把这一路这次请求的用量并进去。换了一次请求（message.id 变了）就从头记 */
export function mergeRequestUsage(
  lanes: Map<string, RequestUsage>,
  lane: string,
  id: unknown,
  usage: unknown,
): RequestUsage | null {
  if (typeof id !== 'string' || !id || !usage || typeof usage !== 'object') return null
  let entry = lanes.get(lane)
  if (entry?.id !== id) {
    entry = { id, usage: {}, reported: 0 }
    lanes.set(lane, entry)
  }
  for (const [key, value] of Object.entries(usage))
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      entry.usage[key] = Math.max(entry.usage[key] ?? 0, value)
  return entry
}

/** 一次请求结束后上下文里有多少 */
export function contextTokens(usage: Record<string, number>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  )
}

/** 主模型的上下文窗口。modelUsage 里找不到这个模型、又不止一个模型时说不准，给 null */
export function contextWindowOf(modelUsage: unknown, model: string | null): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  const entries = Object.entries(modelUsage as Record<string, unknown>)
  const picked =
    (model ? entries.find(([key]) => key === model)?.[1] : undefined) ??
    (entries.length === 1 ? entries[0]?.[1] : undefined)
  const window = (picked as Record<string, unknown> | undefined)?.contextWindow
  return typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null
}

/** CLI 解析出的自动压缩窗口（getContextUsage 的 rawMaxTokens）。不是正整数、或比模型窗口还大时不用 */
export function compactWindowOf(contextUsage: unknown, modelWindow: number | null): number | null {
  if (!contextUsage || typeof contextUsage !== 'object') return null
  const raw = (contextUsage as Record<string, unknown>).rawMaxTokens
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return null
  return modelWindow !== null && raw > modelWindow ? null : raw
}
