export type JsonRpcId = string | number | null

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type WireMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export interface RpcPeer {
  id: string
  send(message: WireMessage): void
  close(): void
}

export type UserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | ({ type: 'image' } & ({ url: string } | { fileId: string }))
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }
