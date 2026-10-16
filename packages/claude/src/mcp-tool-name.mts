// Claude Code 给 MCP 工具起的名字 → 是哪个服务的哪个工具。
// 它的起名规矩（对着 2.1.282 实测，CLI 自己连的服务和适配器桥接进去的服务一样）：
//   mcp__<服务名>__<工具名>，两段里字母、数字、下划线、连字符以外的字符都先换成下划线；
// 双下划线不转义，所以单看名字拆不准：服务 a__b 的工具 c 和服务 a 的工具 b__c 是同一个名字。
// 拆的时候先拿这个会话里实际有的服务名去对，对不上才照 Claude Code 自己的拆法。

const PREFIX = 'mcp__'

// 适配器自己放进去的工具服务（动态工具、目标、权限申请）：实现上是进程内的 MCP 服务，
// 但不是用户配的 MCP 服务，它们的工具不按 MCP 工具报。
const INTERNAL_SERVERS = new Set([
  'codex_harness_adapter',
  'codex_harness_adapter_goal',
  'codex_harness_adapter_permissions',
])

const normalized = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_')

export interface McpToolRef {
  /** 服务名。认得出是哪个服务时是配置里的原名，认不出时是工具名里换过字符的那一段 */
  server: string
  /** 不带前缀的工具名（Claude Code 换过字符之后的样子） */
  tool: string
}

/**
 * 不是 MCP 工具（Claude Code 自带的工具、适配器自己的工具服务）返回 null。
 * servers 是这个会话里有的 MCP 服务的名字（配置里的原名）。
 */
export function mcpToolRef(toolName: string, servers: Iterable<string>): McpToolRef | null {
  if (!toolName.startsWith(PREFIX)) return null
  const ref = knownServerTool(toolName, servers) ?? splitLikeClaudeCode(toolName)
  return ref && !INTERNAL_SERVERS.has(ref.server) ? ref : null
}

// 服务名自己带双下划线、或者以下划线结尾时，只有对着服务名才拆得对；几个服务都对得上取名字最长的。
function knownServerTool(toolName: string, servers: Iterable<string>): McpToolRef | null {
  let found: McpToolRef | null = null
  let longest = 0
  for (const server of servers) {
    const head = `${PREFIX}${normalized(server)}__`
    if (head.length <= longest || toolName.length <= head.length || !toolName.startsWith(head))
      continue
    longest = head.length
    found = { server, tool: toolName.slice(head.length) }
  }
  return found
}

// Claude Code 自己的拆法：前缀之后第一个双下划线之前是服务名，其余都是工具名。
function splitLikeClaudeCode(toolName: string): McpToolRef | null {
  const rest = toolName.slice(PREFIX.length)
  const cut = rest.indexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return null
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}
