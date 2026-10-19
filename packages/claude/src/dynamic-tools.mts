import { createHash } from 'node:crypto'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ValidateFunction } from 'ajv'
import { isClientToolNamespace } from '../../shared/src/client-tool-executor.mjs'
import { dynamicToolResult } from './dynamic-tool-result.mjs'
import { jsonSchemaValidator } from './json-schema.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import type { RuntimeHandlers } from './types.mjs'

export interface DynamicTool {
  name: string
  namespace?: string
  /** 命名空间的说明，只挂在它的第一个工具上（见 toolDescription） */
  namespaceDescription?: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 交给模型的工具说明。CLI 没有“命名空间”这一层，命名空间的说明（比如 litch_machine 开头写的“你在哪台机器、
 * 控制端是哪台”）接在它第一个工具的说明前面，不然模型看不到
 */
export const toolDescription = (tool: DynamicTool): string =>
  `[${tool.namespace ?? 'functions'}.${tool.name}] ${tool.namespaceDescription ? `${tool.namespaceDescription}\n\n` : ''}${tool.description}`

/**
 * 命名空间带的 instructions（clientTools 扩展，protocol/extensions/client-tools.json）：挂上这个命名空间时
 * 要加进系统提示的一段话，拼在会话系统提示的末尾（用户自己的指令之后）。按出现的先后，同一段话只放一次；
 * 一段都没有是 null。形状不对的定义在建会话时已经拒了，这里只挑认得的
 */
export function dynamicToolInstructions(raw: unknown[] | undefined): string | null {
  const sections: string[] = []
  const seen = new Set<string>()
  for (const spec of raw ?? []) {
    const fields = spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : {}
    if (fields.type !== 'namespace' || typeof fields.instructions !== 'string') continue
    const text = fields.instructions.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    sections.push(`# Tool instructions: ${String(fields.name)}\n${text}`)
  }
  return sections.length ? sections.join('\n\n') : null
}

/** 动态工具交给 CLI 的那个进程内 MCP 服务的名字 */
export const DYNAMIC_TOOL_SERVER = 'codex_harness_adapter'

/** 模型看到的工具名（不带 MCP 前缀）。编码完整标识，避免 namespace 和 name 拼接产生碰撞 */
export function dynamicToolName(namespace: string | null | undefined, name: string): string {
  return `t_${createHash('sha256')
    .update(JSON.stringify([namespace ?? null, name]))
    .digest('hex')
    .slice(0, 40)}`
}

const clientToolNames = new WeakMap<unknown[], ReadonlySet<string>>()

/**
 * 会话的动态工具里，客户端工具命名空间（`litch_` 开头，clientTools 扩展）的那些在 CLI 里的完整工具名
 * （`mcp__codex_harness_adapter__t_…`）。这些工具由客户端执行，要不要问用户由执行方决定，
 * 所以不受 Claude Code 这边的沙箱和审批管（和原生 codex 一样：它对动态工具不审批、不按沙箱拦）。
 */
export function clientToolCliNames(raw: unknown[] | undefined): ReadonlySet<string> {
  if (!raw?.length) return new Set()
  const cached = clientToolNames.get(raw)
  if (cached) return cached
  const names = new Set<string>()
  for (const spec of raw) {
    const fields = spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : {}
    if (fields.type !== 'namespace' || typeof fields.name !== 'string') continue
    if (!isClientToolNamespace(fields.name) || !Array.isArray(fields.tools)) continue
    for (const tool of fields.tools)
      if (tool && typeof tool.name === 'string')
        names.add(`mcp__${DYNAMIC_TOOL_SERVER}__${dynamicToolName(fields.name, tool.name)}`)
  }
  clientToolNames.set(raw, names)
  return names
}

/** 把 function 和 namespace 两种定义摊平成一个个工具，命名空间的说明挂在它第一个工具上 */
export function dynamicToolSpecs(raw: unknown[]): DynamicTool[] {
  return raw.flatMap((value): unknown[] => {
    if (!value || typeof value !== 'object') throw new ProtocolError(-32602, '工具定义无效')
    const spec = value as Record<string, unknown>
    if (spec.type === 'function') return [spec]
    if (spec.type !== 'namespace' || !Array.isArray(spec.tools))
      throw new ProtocolError(-32602, '工具定义必须是 function 或 namespace')
    const namespace = requiredString(spec.name, 'namespace.name')
    const about = typeof spec.description === 'string' ? spec.description.trim() : ''
    return spec.tools.map((tool, index) => {
      if (tool?.type !== 'function') throw new ProtocolError(-32602, 'namespace 内必须是 function')
      return {
        ...tool,
        namespace,
        ...(index === 0 && about ? { namespaceDescription: about } : {}),
      }
    })
  }) as DynamicTool[]
}

export function dynamicToolServer(
  raw: unknown[],
  handlers: RuntimeHandlers,
  callIdentity: (name: string, args: unknown) => string,
) {
  const tools = new Map<string, DynamicTool>()
  const schemas = new Map<string, ValidateFunction>()
  const flattened = dynamicToolSpecs(raw)
  for (const value of flattened) {
    if (!value || typeof value !== 'object') throw new ProtocolError(-32602, '工具定义无效')
    const tool = value as DynamicTool
    requiredString(tool.name, 'tool.name')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object')
      throw new ProtocolError(-32602, '工具 inputSchema 无效')
    const name = dynamicToolName(tool.namespace, tool.name)
    if (tools.has(name)) throw new ProtocolError(-32602, '重复工具定义')
    tools.set(name, tool)
    schemas.set(
      name,
      jsonSchemaValidator(tool.inputSchema, { allErrors: true }).compile(tool.inputSchema),
    )
  }
  const config = createSdkMcpServer({ name: DYNAMIC_TOOL_SERVER, version: '1.0.0' })
  config.instance.server.registerCapabilities({ tools: {} })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools].map(([name, tool]) => ({
      name,
      description: toolDescription(tool),
      inputSchema: tool.inputSchema,
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))
  config.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name)
    if (!tool || !handlers.onDynamicToolCall) throw new Error('工具未注册或执行端不可用')
    if (!schemas.get(request.params.name)?.(request.params.arguments ?? {}))
      throw new ProtocolError(-32602, '工具参数不符合 JSON Schema')
    const response = dynamicToolResult(
      await handlers.onDynamicToolCall(
        tool,
        request.params.arguments ?? {},
        callIdentity(request.params.name, request.params.arguments ?? {}),
      ),
    )
    return {
      isError: !response.success,
      content: response.contentItems.map((item) => {
        if (item.type === 'inputText') return { type: 'text', text: String(item.text ?? '') }
        if (item.type === 'inputImage' && typeof item.imageUrl === 'string') {
          const match = /^data:([^;]+);base64,(.+)$/s.exec(item.imageUrl)
          if (match) return { type: 'image', mimeType: match[1], data: match[2] }
        }
        throw new Error(`工具结果类型不支持: ${item.type}`)
      }),
    }
  })
  return config
}
