import { ProtocolError } from './protocol-contract.mjs'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, `${field} 必须是对象`)
  return value as Record<string, unknown>
}

function strings(value: unknown, field: string): Record<string, string> {
  if (value == null) return {}
  const result = record(value, field)
  if (Object.values(result).some((item) => typeof item !== 'string'))
    throw new ProtocolError(-32602, `${field} 的值必须是字符串`)
  return result as Record<string, string>
}

function variable(name: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || env[name] == null)
    throw new ProtocolError(-32602, 'MCP 引用的环境变量不存在或名称无效')
  return env[name]!
}

// Codex 的 MCP 配置与 Claude SDK 字段不同；只翻译连接相关字段，其余字段（如
// default_tools_approval_mode）忽略。MCP 工具审批跟随会话权限：完全访问自动允许，否则询问。
export function sdkMcpServers(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> {
  if (value == null) return {}
  const result: Record<string, any> = {}
  for (const [name, raw] of Object.entries(record(value, 'mcp_servers'))) {
    if (name === 'codex_harness_adapter')
      throw new ProtocolError(-32602, 'codex_harness_adapter 是动态工具专用 MCP 名称')
    const server = record(raw, `mcp_servers.${name}`)
    if (server.enabled === false) continue
    const type = server.type ?? (server.url ? 'http' : 'stdio')
    if (!['stdio', 'http', 'sse'].includes(String(type)))
      throw new ProtocolError(-32602, `不支持 MCP 传输 ${type}`)
    if (type === 'stdio') {
      if (typeof server.command !== 'string' || !server.command)
        throw new ProtocolError(-32602, 'stdio MCP 缺少 command')
      if (
        server.args != null &&
        (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))
      )
        throw new ProtocolError(-32602, 'MCP args 必须是字符串数组')
      const environment = { ...strings(server.env, 'MCP env') }
      if (server.env_vars != null) {
        if (!Array.isArray(server.env_vars)) throw new ProtocolError(-32602, 'env_vars 必须是数组')
        for (const key of server.env_vars) environment[String(key)] = variable(key, env)
      }
      result[name] = { type, command: server.command, args: server.args ?? [], env: environment }
    } else {
      if (typeof server.url !== 'string') throw new ProtocolError(-32602, 'HTTP MCP 缺少 url')
      let url: URL
      try {
        url = new URL(server.url)
      } catch {
        throw new ProtocolError(-32602, 'MCP url 无效')
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new ProtocolError(-32602, 'MCP url 协议无效')
      const headers = {
        ...strings(server.http_headers, 'http_headers'),
        ...strings(server.headers, 'headers'),
      }
      for (const [header, key] of Object.entries(
        strings(server.env_http_headers, 'env_http_headers'),
      ))
        headers[header] = variable(key, env)
      if (server.bearer_token_env_var != null)
        headers.Authorization = `Bearer ${variable(server.bearer_token_env_var, env)}`
      result[name] = { type, url: server.url, headers }
    }
    result[name].alwaysLoad = true
    if (server.tool_timeout_sec != null) {
      if (
        typeof server.tool_timeout_sec !== 'number' ||
        !Number.isFinite(server.tool_timeout_sec) ||
        server.tool_timeout_sec < 1
      )
        throw new ProtocolError(-32602, 'MCP tool_timeout_sec 必须至少一秒')
      result[name].timeout = Math.ceil(server.tool_timeout_sec * 1000)
    } else if (server.timeout != null) {
      if (
        typeof server.timeout !== 'number' ||
        !Number.isFinite(server.timeout) ||
        server.timeout < 1
      )
        throw new ProtocolError(-32602, 'MCP timeout 必须是正数毫秒')
      result[name].timeout = server.timeout
    }
  }
  return result
}

export function sdkMcpStartupEnvironment(value: unknown): Record<string, string> {
  if (value == null) return {}
  const timeouts = new Set<number>()
  for (const raw of Object.values(record(value, 'mcp_servers'))) {
    const server = record(raw, 'MCP server')
    if (server.enabled === false || server.startup_timeout_sec == null) continue
    const timeout = server.startup_timeout_sec
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
      throw new ProtocolError(-32602, 'MCP startup_timeout_sec 无效')
    timeouts.add(Math.ceil(timeout * 1000))
  }
  // 固定 SDK 仅提供进程级启动超时，拒绝无法准确表达的逐服务器差异。
  if (timeouts.size > 1)
    throw new ProtocolError(-32602, '当前 SDK 不支持不同 MCP 服务器使用不同启动超时')
  const timeout = [...timeouts][0]
  return timeout == null
    ? {}
    : { MCP_TIMEOUT: String(timeout), MCP_CONNECT_TIMEOUT_MS: String(timeout) }
}
