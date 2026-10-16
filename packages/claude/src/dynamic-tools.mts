import { createHash } from 'node:crypto'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ValidateFunction } from 'ajv'
import { dynamicToolResult } from './dynamic-tool-result.mjs'
import { jsonSchemaValidator } from './json-schema.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import type { RuntimeHandlers } from './types.mjs'

export interface DynamicTool {
  name: string
  namespace?: string
  description: string
  inputSchema: Record<string, unknown>
}

export function dynamicToolServer(
  raw: unknown[],
  handlers: RuntimeHandlers,
  callIdentity: (name: string, args: unknown) => string,
) {
  const tools = new Map<string, DynamicTool>()
  const schemas = new Map<string, ValidateFunction>()
  const flattened = raw.flatMap((value) => {
    if (!value || typeof value !== 'object') throw new ProtocolError(-32602, '工具定义无效')
    const spec = value as Record<string, unknown>
    if (spec.type === 'function') return [spec]
    if (spec.type !== 'namespace' || !Array.isArray(spec.tools))
      throw new ProtocolError(-32602, '工具定义必须是 function 或 namespace')
    const namespace = requiredString(spec.name, 'namespace.name')
    return spec.tools.map((tool) => {
      if (tool?.type !== 'function') throw new ProtocolError(-32602, 'namespace 内必须是 function')
      return { ...tool, namespace }
    })
  })
  for (const value of flattened) {
    if (!value || typeof value !== 'object') throw new ProtocolError(-32602, '工具定义无效')
    const tool = value as DynamicTool
    requiredString(tool.name, 'tool.name')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object')
      throw new ProtocolError(-32602, '工具 inputSchema 无效')
    // 编码完整标识，避免 namespace 和 name 拼接产生碰撞。
    const name = `t_${createHash('sha256')
      .update(JSON.stringify([tool.namespace ?? null, tool.name]))
      .digest('hex')
      .slice(0, 40)}`
    if (tools.has(name)) throw new ProtocolError(-32602, '重复工具定义')
    tools.set(name, tool)
    schemas.set(
      name,
      jsonSchemaValidator(tool.inputSchema, { allErrors: true }).compile(tool.inputSchema),
    )
  }
  const config = createSdkMcpServer({ name: 'codex_harness_adapter', version: '1.0.0' })
  config.instance.server.registerCapabilities({ tools: {} })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools].map(([name, tool]) => ({
      name,
      description: `[${tool.namespace ?? 'functions'}.${tool.name}] ${tool.description}`,
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
