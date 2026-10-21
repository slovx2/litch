// 直接从一份 Claude Code 原生记录（jsonl）里读几样 SDK 的 getSessionMessages 不给的东西，给导进来的会话用
// （native-sessions.mts）：上下文占用、有没有压缩过、别处最后用的设置。纯读，读不到、格式不对的行跳过。
//
// - 占用：最后一次顶层请求（不是子代理的）的用量。同一次请求按内容块拆成几行写，按 message.id 合在一起、各项取最大。
//   那之后压缩过的，取压缩边界里记的压缩后的词元数（compactMetadata.postTokens），等下一次请求再换回请求的用量。
// - 设置：只看不是程序化入口（sdk-ts、sdk-cli 这些，入口自己跑的 CLI 也是）写的行，各取最后一次：
//   模型（助手行的 requestedModel，其次 message.model）、推理强度（助手行的 effort）、
//   权限模式（用户行的 permissionMode，计划模式是 plan）。

import { readFileSync } from 'node:fs'
import { tokenBreakdownFromClaudeUsage } from './server-helpers.mjs'
import type { TokenUsageBreakdown } from './types.mjs'

/** 别处最后用的设置：原样的值，怎么换成会话设置由调用的地方定 */
export interface NativeSettings {
  model?: string
  effort?: string
  permissionMode?: string
}

export interface NativeRecordFacts {
  /** 现在上下文里有多少，和那时的主模型。一次请求都没有、也没压缩过的是 null */
  usage: { last: TokenUsageBreakdown; model: string | null } | null
  /** 记录里有压缩边界 */
  compacted: boolean
  settings: NativeSettings
}

const PROGRAMMATIC = /^sdk-/
/** 模型名占位：本地合成的助手消息（打断、出错）上是这个 */
const SYNTHETIC = '<synthetic>'

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export function readNativeRecordFacts(path: string): NativeRecordFacts {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return { usage: null, compacted: false, settings: {} }
  }
  return nativeRecordFacts(content)
}

export function nativeRecordFacts(content: string): NativeRecordFacts {
  let request = null as { id: string; usage: Record<string, number> } | null
  let model: string | null = null
  let compactedTo: number | null = null
  let compacted = false
  const settings: NativeSettings = {}
  for (const line of content.split('\n')) {
    // 先按字面筛一遍：大多数行（附件、请求快照）用不着，不值得解析
    if (
      !line.includes('"assistant"') &&
      !line.includes('"compact_boundary"') &&
      !line.includes('"permissionMode"')
    )
      continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    const external = typeof entry.entrypoint !== 'string' || !PROGRAMMATIC.test(entry.entrypoint)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      compacted = true
      const post = (entry.compactMetadata as Record<string, unknown> | undefined)?.postTokens
      compactedTo = typeof post === 'number' && Number.isSafeInteger(post) && post > 0 ? post : null
      request = null
      continue
    }
    if (entry.type === 'user') {
      const mode = text(entry.permissionMode)
      if (external && mode) settings.permissionMode = mode
      continue
    }
    if (entry.type !== 'assistant') continue
    const message = entry.message as Record<string, unknown> | undefined
    const used = text(message?.model)
    if (!message || used === SYNTHETIC) continue
    if (external) {
      const chosen = text(entry.requestedModel) ?? used
      if (chosen) settings.model = chosen
      const effort = text(entry.effort)
      if (effort) settings.effort = effort
    }
    const usage = message.usage
    const id = text(message.id)
    if (!id || !usage || typeof usage !== 'object') continue
    if (request?.id !== id) request = { id, usage: {} }
    for (const [key, value] of Object.entries(usage as Record<string, unknown>))
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        request.usage[key] = Math.max(request.usage[key] ?? 0, value)
    if (used) model = used
    compactedTo = null
  }
  const usage = request
    ? { last: tokenBreakdownFromClaudeUsage(request.usage), model }
    : compactedTo !== null
      ? {
          last: {
            totalTokens: compactedTo,
            inputTokens: compactedTo,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          model,
        }
      : null
  return { usage, compacted, settings }
}
