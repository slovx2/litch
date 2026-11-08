// 执行器内部的线格式；对外入口以 automation-contracts 的 ToolInvocation/ToolResult 为准。
export interface ClientToolInvocation {
  id: string
  callId: string
  threadId: string
  turnId: string
  namespace: string | null
  tool: string
  arguments: unknown
  device: { id: string }
}
export type ClientToolAnswer = 'once' | 'session' | 'always' | 'decline'
export interface SelfApprovalCard {
  pairedOnly: true
  id: string
  nonce: string
  origin: string
  accounts: { ref: string }[]
  deviceId: string
}
export interface ClientToolAsk {
  kind: 'computerSelf'
  id: string
  nonce: string
  desktopId: string | null
}
export interface ClientToolContext {
  signal: AbortSignal
  ask(ask: ClientToolAsk): Promise<ClientToolAnswer | null>
  hold?(): () => void
  show?(ask: ClientToolAsk, answer?: (choice: ClientToolAnswer | null) => void): () => void
}
export type ClientToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
export interface ClientToolCallResponse {
  success: boolean
  contentItems: ClientToolContentItem[]
}
export interface ClientToolExecutor {
  namespace: string
  call(call: ClientToolInvocation, context: ClientToolContext): Promise<ClientToolCallResponse>
  turnEnded?(scope: { deviceId: string; threadId: string; turnId: string }): Promise<void>
  phoneAnswer?(answer: unknown): void
}
export const CLIENT_TOOL_NAMESPACE = { computer: 'litch_computer' } as const
export function clientToolFailure(kind: string, message: string): ClientToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: 'inputText', text: `[litch:${kind}] ${message}` }],
  }
}
