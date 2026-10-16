// 设备进程里各处共用的最小概念：一条能收发文本帧的通道、JSON-RPC 的消息形状、聚合面自己的错误。
// 线上格式和运行时一样：每帧一条 JSON，请求有 id 和 method，通知只有 method，应答有 id 加 result 或 error。
import {
  DEVICE_ERROR_CODE,
  type DeviceErrorData,
  type DeviceErrorReason,
} from '../../protocol/src/device.mjs'

/** 一条连接的发送端。客户端连进来的那条、设备进程连到上游的那条，都是它 */
export interface Wire {
  /** flushed：这一帧（连同排在它前面的）已经交给系统了。只有设备层的流量控制用，连接断了不会调用 */
  send(text: string, flushed?: () => void): void
  close(): void
  /** 已经交出去、系统还没有收下的字节数（发送积压）。不给就当作没有积压 */
  backlog?(): number
}

/** 一条连接的接收端 */
export interface WireHandlers {
  message(text: string): void
  /** 连接断了。连上之后才会调用，至多一次 */
  close(reason: string): void
}

/** 连到一个上游。连不上就拒绝；连上之后的断开经 handlers.close 报告 */
export type Connector = (handlers: WireHandlers) => Promise<Wire>

export type RpcId = string | number

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** 解析之后的一帧。只用到 id、method、params、result、error，别的字段原样带着 */
export interface Frame {
  id?: RpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

/** 数字 1 和字符串 "1" 是两个不同的请求号，做键时要分开 */
export function idKey(id: unknown): string {
  return typeof id === 'number' ? `n:${id}` : `s:${String(id)}`
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 聚合面自己回的错误：原因放在 `error.data.litch` 里，错误码由原因决定 */
export class DeviceError extends Error {
  readonly code: number
  readonly data: DeviceErrorData

  constructor(
    reason: DeviceErrorReason,
    message: string,
    detail: Omit<DeviceErrorData, 'litch'> = {},
  ) {
    super(message)
    this.code = DEVICE_ERROR_CODE[reason]
    this.data = { litch: reason, ...detail }
  }
}

/** 把任何抛出来的东西变成线上的 error 对象 */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof DeviceError)
    return { code: error.code, message: error.message, data: error.data }
  // 复用的设备层实现（终端、文件）抛的是带 code 的 ProtocolError；上游回的错误对象也是这个形状
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    const data = (error as { data?: unknown }).data
    return {
      code: typeof code === 'number' ? code : -32603,
      message: error.message,
      ...(data === undefined ? {} : { data }),
    }
  }
  return { code: -32603, message: String(error) }
}

/** 上游回的错误，原样带给调用方 */
export class UpstreamRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: RpcError) {
    super(error.message)
    this.code = error.code
    this.data = error.data
  }
}
