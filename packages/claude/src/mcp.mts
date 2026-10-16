import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sdkMcpServers } from './mcp-config.mjs'
import { ProtocolError } from './protocol-contract.mjs'

// 环境变量允许内联 JSON 或配置文件；重新读取文件以支持显式重载。
export function readMcpConfig(): Record<string, unknown> {
  const directory = process.env.CLAUDE_CONFIG_DIR
  const path = directory ? join(directory, '.claude.json') : join(homedir(), '.claude.json')
  let native: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    native = parsed.mcpServers ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ProtocolError(-32602, '用户级 MCP 配置读取失败')
  }
  const raw = process.env.CHA_CLAUDE_MCP_SERVERS?.trim()
  if (!raw) return mergeMcpConfig(native)
  try {
    const value = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'))
    return mergeMcpConfig(native, value)
  } catch {
    throw new ProtocolError(-32602, 'MCP 配置读取失败')
  }
}

// 原生用户配置作为基础，任务只需覆盖请求头，不必携带连接凭据。
export function mergeMcpConfig(...layers: unknown[]): Record<string, unknown> {
  const result: Record<string, any> = {}
  for (const layer of layers) {
    if (layer == null) continue
    if (typeof layer !== 'object' || Array.isArray(layer))
      throw new ProtocolError(-32602, 'MCP 配置必须是对象')
    for (const [name, entry] of Object.entries(layer)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new ProtocolError(-32602, 'MCP 服务配置必须是对象')
      const previous = result[name] ?? {}
      const next = { ...previous, ...entry }
      for (const key of ['headers', 'http_headers', 'env_http_headers']) {
        if (previous[key] != null || (entry as any)[key] != null)
          next[key] = { ...previous[key], ...(entry as any)[key] }
      }
      result[name] = next
    }
  }
  sdkMcpServers(result)
  return result
}
