/** ACP 专用控制，不携带登录凭据。只能在声明 acpControls 的连接上使用。 */
export interface AcpAuthMethod {
  id: string
  name: string
  description: string | null
  type: string
  args?: string[]
}

export interface AcpAuthView {
  methods: AcpAuthMethod[]
  logout: boolean
  instruction: string | null
  /** agy 的只读会话查询验证鉴权；其他 agent 没有状态接口时保持 unknown。 */
  status?: 'signedIn' | 'signedOut' | 'unknown'
}

export interface AcpControlsRequests {
  'litch/acp/auth/read': {
    params: { harness?: string }
    result: AcpAuthView
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
