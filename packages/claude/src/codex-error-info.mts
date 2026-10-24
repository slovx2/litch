// 回合失败时 TurnError 上的 codexErrorInfo：把 Claude Code 报的模型接口错误归到上游 codex 的同名种类，
// 客户端（比如按 serverOverloaded 做容量重试的）不用分引擎认错误文字。
//
// 依据是上游 rust-v0.163.0：`protocol/src/error.rs` 的 to_codex_protocol_error 和 `codex-api/src/api_bridge.rs`
// 的 map_api_error。对应关系：
//   过载（Anthropic 529 / overloaded_error，对应 codex 503 server_is_overloaded）→ serverOverloaded
//   429：额度、余额用完（codex 的 usage_limit_reached、insufficient_quota）→ usageLimitExceeded；
//        其余 429（codex 重试用完）→ responseTooManyFailedAttempts{httpStatusCode: 429}
//   余额、计费错误（Anthropic 的 billing_error，不论状态码）→ usageLimitExceeded
//   上下文超长（prompt is too long）→ contextWindowExceeded
//   鉴权失败（401、authentication_failed）→ unauthorized
//   500 → internalServerError
//   400 其余（codex 的 InvalidRequest）→ other
//   其余带状态码的（403、404、502、503、504…，codex 的 UnexpectedStatus）→ httpConnectionFailed{httpStatusCode}
//   没有状态码的连接错误（超时、连不上、连接被断开）→ httpConnectionFailed{httpStatusCode: null}。
//        CLI 给连接中断也可能归成 server_error，所以先按文字认连接错误，再看这个类
// 认不出是模型接口错误的（工具、钩子、入口自己的失败）不给，和上游一样是 null。

export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'unauthorized'
  | 'internalServerError'
  | 'other'
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }

export interface ModelApiError {
  /** 模型接口回的 HTTP 状态码（结果消息的 api_error_status）；连接错误没有 */
  status?: number | null | undefined
  /** CLI 给这次错误归的类（助手消息上的 error，SDK 的 SDKAssistantMessageError） */
  category?: string | null | undefined
  /** CLI 报的错误文字（结果正文），兜底时按它认 */
  text?: string | null | undefined
}

const OVERLOADED = /\b529\b|overloaded/i
const CONTEXT = /prompt is too long|context (window|length)|exceeds? (the )?(maximum )?context/i
const QUOTA = /credit balance|billing|quota|usage limit|spend limit/i
const CONNECTION =
  /connection (error|dropped|closed|refused|reset)|unable to connect|socket hang up|timed? ?out|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed/i

export function codexErrorInfoFor(error: ModelApiError): CodexErrorInfo | null {
  const status = typeof error.status === 'number' ? error.status : null
  const category = error.category ?? null
  const text = error.text ?? ''
  if (status === null && !category && !/API Error/i.test(text)) return null
  if (status === 529 || category === 'overloaded' || (status === null && OVERLOADED.test(text)))
    return 'serverOverloaded'
  if (category === 'billing_error' || (status === 429 && QUOTA.test(text)))
    return 'usageLimitExceeded'
  if (status === 429 || category === 'rate_limit')
    return { responseTooManyFailedAttempts: { httpStatusCode: status ?? 429 } }
  if (CONTEXT.test(text)) return 'contextWindowExceeded'
  if (
    status === 401 ||
    category === 'authentication_failed' ||
    category === 'oauth_org_not_allowed'
  )
    return 'unauthorized'
  if (status === 500) return 'internalServerError'
  if (status === 400 || category === 'invalid_request') return 'other'
  if (status !== null) return { httpConnectionFailed: { httpStatusCode: status } }
  if (CONNECTION.test(text)) return { httpConnectionFailed: { httpStatusCode: null } }
  if (category === 'server_error') return 'internalServerError'
  return 'other'
}

/** 带着 codexErrorInfo 的回合失败；入口拼 TurnError 时取它 */
export class TurnFailure extends Error {
  readonly codexErrorInfo: CodexErrorInfo | null
  constructor(message: string, codexErrorInfo: CodexErrorInfo | null) {
    super(message)
    this.codexErrorInfo = codexErrorInfo
  }
}

/** TurnError 的形状：有种类时带上 codexErrorInfo，没有时和原来一样只有 message */
export function turnErrorOf(error: Error): { message: string; codexErrorInfo?: CodexErrorInfo } {
  const info = error instanceof TurnFailure ? error.codexErrorInfo : null
  return info ? { message: error.message, codexErrorInfo: info } : { message: error.message }
}
