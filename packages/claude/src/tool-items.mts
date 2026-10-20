// Claude 的一次工具调用（tool_use 块）在协议里画成哪种条目。实时回合（server.mts）和读原生会话的历史
// （native-history.mts）共用这一份，两边画出来的一样。条目还没有结果；结果到了用 server-helpers 的
// toolItemWithResult 收尾。
import { isAbsolute, resolve } from 'node:path'
import { mcpToolRef } from './mcp-tool-name.mjs'
import { fileChangeFromTool } from './server-helpers.mjs'
import type { ThreadItem } from './types.mjs'
import { newId } from './util.mjs'

export interface ToolUse {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export function toolUseItem(
  event: ToolUse,
  cwd: string,
  mcpServers: readonly string[],
  id: string = newId(),
): ThreadItem {
  if (event.toolName === 'Bash') {
    return {
      type: 'commandExecution',
      id,
      command: String(event.input.command ?? ''),
      cwd: String(event.input.cwd ?? cwd),
      // Use the SDK's tool_use_id as a stable handle. Without a non-null
      // processId the Codex App was treating these as "Background terminal"
      // entries (no attached process) and hiding their output; with a
      // synthetic id they render as inline command items like a normal
      // foreground bash invocation.
      processId: `claude:${event.toolUseId}`,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  }
  if (['Edit', 'Write', 'MultiEdit'].includes(event.toolName)) {
    return {
      type: 'fileChange',
      id,
      changes: fileChangeFromTool(event.toolName, event.input),
      status: 'inProgress',
    }
  }
  if (event.toolName === 'WebSearch') {
    // Codex App has a dedicated `webSearch` ThreadItem with a structured
    // action — emit it instead of a generic mcpToolCall so the App can show
    // the search badge (and follow-up open-page links) natively. The action
    // is finalized when the tool_result arrives (see tool_result handler).
    // The 'search' variant's `query` / `queries` are required (Option fields
    // with no serde default), so always populate both even on the initial
    // inProgress emit.
    const q = String(event.input.query ?? '')
    return {
      type: 'webSearch',
      id,
      query: q,
      action: { type: 'search', query: q || null, queries: null },
    }
  }
  let displayTool = event.toolName
  if (event.toolName === 'Read') {
    const raw = String(event.input.file_path || event.input.path || '')
    if (raw) {
      let displayPath = raw
      try {
        if (cwd && raw.startsWith(cwd)) {
          displayPath = raw.slice(cwd.length).replace(/^\/+/, '')
        } else {
          const parts = raw.split(/\//).filter(Boolean)
          displayPath = parts.length > 2 ? parts.slice(-2).join('/') : raw
        }
      } catch {}
      displayTool = `Read ${displayPath || raw}`
    }
  } else if (event.toolName === 'Grep') {
    const pat = String(event.input.pattern ?? '')
    const rawPath = event.input.path ? String(event.input.path) : ''
    let pathStr = ''
    if (rawPath) {
      const parts = rawPath.split(/\//).filter(Boolean)
      pathStr = ` (${parts.length > 2 ? parts.slice(-2).join('/') : rawPath})`
    }
    if (pat) displayTool = `Grep ${pat}${pathStr}`
  } else if (event.toolName === 'Glob') {
    const pat = String(event.input.pattern ?? '')
    if (pat) displayTool = `Glob ${pat}`
  }

  // 真正的 MCP 工具报它所在的服务和不带前缀的工具名；Claude Code 自带的工具没有服务，记在 claude-code 名下。
  const mcp = mcpToolRef(event.toolName, mcpServers)
  return {
    type: 'mcpToolCall',
    id,
    server: mcp?.server ?? 'claude-code',
    tool: mcp?.tool ?? displayTool,
    status: 'inProgress',
    arguments: event.input,
    result: null,
    error: null,
    durationMs: null,
  }
}

// 模型用 Read 读了一张图（结果里有图片块）：照上游 view_image 另记一个 imageView 条目，路径是绝对路径。
// Read 自己的那条工具条目照旧留着；读失败、读的不是图都没有。实时回合和读历史都在工具结果到时调它。
export function readImageView(
  item: ThreadItem,
  content: unknown,
  isError: boolean,
  cwd: string,
): Extract<ThreadItem, { type: 'imageView' }> | null {
  if (isError || item.type !== 'mcpToolCall' || item.server !== 'claude-code') return null
  if (!/^Read(?: |$)/.test(item.tool)) return null
  const args = (item.arguments ?? {}) as Record<string, unknown>
  const raw = args.file_path ?? args.path
  if (typeof raw !== 'string' || !raw) return null
  const blocks = Array.isArray(content) ? content : []
  if (!blocks.some((block) => (block as { type?: unknown } | null)?.type === 'image')) return null
  return {
    type: 'imageView',
    id: `${item.id}:image`,
    path: isAbsolute(raw) ? raw : resolve(cwd, raw),
  }
}
