// app-server 线上格式是不带 "jsonrpc" 字段的 JSON-RPC 2.0：请求有 id 和 method，
// 通知只有 method，应答有 id 加 result 或 error。两个方向都可以发请求。

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse =
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: JsonRpcError }

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message)
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && 'id' in message
}
