// 核心的结构化摘要：对设备的请求、设备发来的请求、连接状态的变化、界面命令。
// 写到哪由外壳定（桌面端是 core.jsonl）；核心只交出事件名和少量字段，不带正文、文件内容、命令和输出、密钥。

export type TraceLevel = 'info' | 'warn' | 'error'

/** 记一条摘要。不给就不记 */
export type CoreTrace = (event: string, fields: Record<string, unknown>, level?: TraceLevel) => void

const ID_KEY = /(^|[a-z])Id$/
const ID_LIMIT = 100
const ERROR_LIMIT = 500

/** 从参数里挑出标识类的字段：名字以 Id 结尾的、harness。只看第一层，只要字符串和数字 */
export function traceIds(params: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return result
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (key !== 'harness' && !ID_KEY.test(key)) continue
    if (typeof value === 'string') result[key] = value.slice(0, ID_LIMIT)
    else if (typeof value === 'number') result[key] = value
  }
  return result
}

/** 错误原文：截到 500 字 */
export function traceError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : error !== null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}…` : text
}

/** 给每一条都添上同样的字段（比如是哪台设备） */
export function traceWith(trace: CoreTrace, extra: Record<string, unknown>): CoreTrace {
  return (event, fields, level) => trace(event, { ...extra, ...fields }, level)
}
