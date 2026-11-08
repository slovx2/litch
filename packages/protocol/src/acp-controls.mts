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

/** agy 无浏览器登录的第一步：设备侧进程已等待用户粘贴回调 URL 或授权码。 */
export interface AcpAuthLogin {
  attemptId: string
  url: string
  prompt: { id: 'authorizationCode'; title: string; secret: false }
}

export interface AcpControlsRequests {
  'litch/acp/auth/read': {
    params: { harness?: string }
    result: AcpAuthView
  }
  'litch/acp/auth/authenticate': {
    params: { harness?: string; methodId: string }
    result: { login?: AcpAuthLogin }
  }
  'litch/acp/auth/continue': {
    params: { harness?: string; attemptId: string; authorizationCode: string }
    result: Record<string, never>
  }
  'litch/acp/auth/cancel': {
    params: { harness?: string; attemptId: string }
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
