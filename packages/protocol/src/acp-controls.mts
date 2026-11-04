/** ACP 专用控制，不携带登录凭据。只能在声明 acpControls 的连接上使用。 */
export interface AcpAuthMethod {
  id: string
  name: string
  description: string | null
  type: string
  args?: string[]
}

export interface AcpControlsRequests {
  'litch/acp/auth/read': {
    params: { harness?: string }
    result: { methods: AcpAuthMethod[]; logout: boolean; instruction: string | null }
  }
  'litch/acp/auth/authenticate': {
    params: { harness?: string; methodId: string }
    result: Record<string, never>
  }
  'litch/acp/auth/logout': {
    params: { harness?: string }
    result: Record<string, never>
  }
  'litch/acp/config/read': {
    params: { threadId: string }
    result: { configOptions: Record<string, unknown>[] }
  }
  'litch/acp/config/set': {
    params: { threadId: string; configId: string; value: string | boolean }
    result: { configOptions: Record<string, unknown>[] }
  }
}
