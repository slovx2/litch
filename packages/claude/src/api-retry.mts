// CLI 自己重试模型请求（apiRetry 扩展）。每次重试前 SDK 流里来一条 system/api_retry（2.1.282 实测，
// 2.1.299 的 SDKAPIRetryMessage 同形）：
//   attempt 第几次、max_retries 最多几次（CLAUDE_CODE_MAX_RETRIES，默认 10）、retry_delay_ms 多久后重试、
//   error_status 失败那次的 HTTP 状态码（连接错误是 null）、error 是 SDKAssistantMessageError 之一（连接错误是 unknown）、
//   no_response 只在等响应头超时（CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS）时有，这时 max_retries 是它自己的上限。
// CLI 只在这次请求还没出过助手消息时重试；出过的话不重试，留下收到的部分、补一句让模型接着说（与重试设置无关）。

import type { ApiRetryReason, TurnApiRetry } from '../../protocol/src/api-retry.mjs'
import { type CodexErrorInfo, codexErrorInfoFor } from './codex-error-info.mjs'

function count(value: unknown, least: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= least ? value : null
}

function reasonOf(status: number | null, category: unknown, noResponse: boolean): ApiRetryReason {
  if (noResponse) return 'noResponse'
  if (status === 529 || category === 'overloaded') return 'overloaded'
  if (status === 429 || category === 'rate_limit') return 'rateLimit'
  if (status === null) return 'connection'
  if (status >= 500 || category === 'server_error') return 'server'
  return 'other'
}

/** CLI 的 api_retry 消息读成协议里的重试状态；不像样（没有第几次）时是 null */
export function apiRetryOf(message: Record<string, unknown>): TurnApiRetry | null {
  const attempt = count(message.attempt, 1)
  if (attempt === null) return null
  const httpStatus = count(message.error_status, 100)
  const noResponse = Boolean(message.no_response && typeof message.no_response === 'object')
  return {
    attempt,
    maxRetries: count(message.max_retries, 1),
    retryDelayMs: count(message.retry_delay_ms, 0),
    httpStatus,
    reason: reasonOf(httpStatus, message.error, noResponse),
  }
}

const DETAILS: Record<ApiRetryReason, string> = {
  connection: 'Connection error',
  noResponse: 'No response from the API',
  overloaded: 'API overloaded',
  rateLimit: 'Rate limited',
  server: 'API server error',
  other: 'API error',
}

/**
 * 上游 error 通知（willRetry 为真）里的 TurnError，照上游 codex 重试时的写法（responses_retry.rs 的
 * “Reconnecting... 第几次/最多几次”，additionalDetails 是失败的原因）。没声明 apiRetry 的连接只看得到这个
 */
export function retryTurnError(retry: TurnApiRetry): {
  message: string
  codexErrorInfo: CodexErrorInfo
  additionalDetails: string
} {
  const progress = retry.maxRetries ? `${retry.attempt}/${retry.maxRetries}` : String(retry.attempt)
  const info =
    retry.httpStatus === null
      ? { httpConnectionFailed: { httpStatusCode: null } }
      : (codexErrorInfoFor({
          status: retry.httpStatus,
          category: retry.reason === 'overloaded' ? 'overloaded' : null,
        }) ?? 'other')
  const status = retry.httpStatus === null ? '' : ` (HTTP ${retry.httpStatus})`
  return {
    message: `Reconnecting... ${progress}`,
    codexErrorInfo: info,
    additionalDetails: `${DETAILS[retry.reason]}${status}`,
  }
}
