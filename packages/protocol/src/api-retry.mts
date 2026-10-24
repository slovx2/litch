// 模型请求在重试（扩展名 apiRetry）：harness 自己在重试一次失败的模型请求（Claude Code 的 CLI 遇到连接中断、
// 过载、5xx 时默认重试），回合没有失败，状态行写“重试中 第几次/最多几次”，重试成功后消失。
// 上游的 error 通知（willRetry 为真）照常发给每条连接；这里加的结构化内容只发给声明了这个扩展的连接。
// 定义的原文在仓库根目录 protocol/extensions/api-retry.json。
//
// 这个文件不引用别的文件：各个入口和客户端核心都直接引用它。

/**
 * 为什么重试。客户端遇到不认识的值按 other 处理。
 * - connection：连接中断、连不上，没有 HTTP 状态码
 * - noResponse：等了很久没有收到响应头
 * - overloaded：服务过载（Anthropic 的 529）
 * - rateLimit：被限流（429）
 * - server：服务端出错（其余的 5xx 等）
 */
export type ApiRetryReason =
  | 'connection'
  | 'noResponse'
  | 'overloaded'
  | 'rateLimit'
  | 'server'
  | 'other'

export interface TurnApiRetry {
  /** 第几次重试，从 1 开始 */
  attempt: number
  /** 最多重试几次；harness 没说是 null */
  maxRetries: number | null
  /** 多久之后重试（毫秒）；harness 没说是 null */
  retryDelayMs: number | null
  /** 失败的那次请求的 HTTP 状态码；连接错误没有，是 null */
  httpStatus: number | null
  reason: ApiRetryReason
}

/** 回合的重试状态变了：retry 是 null 表示重试结束了（请求有了回应，或回合结束） */
export interface ApiRetryUpdatedNotification {
  threadId: string
  turnId: string
  retry: TurnApiRetry | null
  /**
   * 失败的那次请求已经流出来、作废了的条目（还没定稿的半截回答）。入口已把它们从回合里删掉，
   * 并对它们发过一次正文为空的 item/completed；声明了的客户端把它们从对话里撤掉。没有时不带
   */
  discardedItemIds?: string[]
}

export const API_RETRY_NOTIFICATION = {
  updated: 'litch/turn/apiRetry/updated',
} as const
