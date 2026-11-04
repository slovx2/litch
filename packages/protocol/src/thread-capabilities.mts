import type { Model } from './codex.mjs'
import type { HarnessDeclaration } from './harness-capabilities.mjs'

/** 会话后端的完整声明；缺省沿用 harness 级声明，存在时整体替换，不作能力并集。 */
export interface ThreadCapabilities extends HarnessDeclaration {
  models?: Model[]
  planMode?: boolean
}

export function threadCapabilities(thread: unknown): ThreadCapabilities | null {
  const value = (thread as { litchCapabilities?: unknown } | null)?.litchCapabilities
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ThreadCapabilities)
    : null
}
