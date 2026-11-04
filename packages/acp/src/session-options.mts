import { isAbsolute } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { AgentCapabilities } from './declaration.mjs'

/** 仅显式声明 acpControls 的客户端可提供；每次重连重新检查当前 agent 能力。 */
export function sessionOptions(
  value: any,
  caps: AgentCapabilities,
): { additionalDirectories?: string[]; mcpServers: any[] } {
  if (value == null) return { mcpServers: [] }
  const directories = value.additionalDirectories ?? []
  if (
    !Array.isArray(directories) ||
    directories.some((path) => typeof path !== 'string' || !isAbsolute(path))
  )
    throw new ProtocolError(-32602, 'additionalDirectories 必须为绝对路径数组')
  if (directories.length && !caps.additionalDirectories)
    throw new ProtocolError(-32004, 'agent 没有声明 additionalDirectories')
  const servers = value.mcpServers ?? []
  if (!Array.isArray(servers)) throw new ProtocolError(-32602, 'mcpServers 必须为数组')
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !server.name)
      throw new ProtocolError(-32602, 'MCP 服务必须有名称')
    if (server.type === 'http' || server.type === 'sse') {
      if (!(server.type === 'http' ? caps.mcpHttp : caps.mcpSse))
        throw new ProtocolError(-32004, `agent 没有声明 MCP ${server.type}`)
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url))
        throw new ProtocolError(-32602, 'MCP URL 必须为 HTTP(S)')
    } else if (
      server.type != null ||
      typeof server.command !== 'string' ||
      !server.command ||
      !Array.isArray(server.args) ||
      server.args.some((arg: unknown) => typeof arg !== 'string') ||
      !Array.isArray(server.env) ||
      server.env.some(
        (entry: any) => typeof entry?.name !== 'string' || typeof entry?.value !== 'string',
      )
    )
      throw new ProtocolError(-32602, '无效的 MCP stdio 服务')
  }
  return {
    ...(directories.length ? { additionalDirectories: directories } : {}),
    mcpServers: servers,
  }
}
