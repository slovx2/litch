import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Ajv } from 'ajv'
import type { RuntimeHandlers } from './types.mjs'

const schemas: Record<string, Record<string, unknown>> = {
  get_goal: { type: 'object', properties: {}, additionalProperties: false },
  create_goal: {
    type: 'object',
    required: ['objective'],
    additionalProperties: false,
    properties: {
      objective: { type: 'string', minLength: 1 },
      token_budget: { type: 'integer', minimum: 1 },
    },
  },
  update_goal: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: { status: { type: 'string', enum: ['complete', 'blocked'] } },
  },
}
const descriptions: Record<string, string> = {
  get_goal: '读取当前目标、状态、已使用 token 和执行时间。',
  create_goal: '仅当用户明确要求持续目标时创建。未完成目标不得替换；完成目标被替换时重新计账。',
  update_goal:
    '只有目标真正完成才设 complete。仅持续且无法自行解决的阻塞可设 blocked。不能暂停、扩大预算或恢复目标。',
}

export function isGoalTool(name: string): boolean {
  return Object.keys(schemas).some((tool) => name === 'mcp__codex_harness_adapter_goal__' + tool)
}

export function goalToolServer(
  handlers: RuntimeHandlers,
  identity: (name: string, args: unknown) => string,
) {
  const config = createSdkMcpServer({ name: 'codex_harness_adapter_goal', version: '1.0.0' })
  const ajv = new Ajv({ strict: false })
  const validators = new Map(
    Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
  )
  config.instance.server.registerCapabilities({ tools: {} })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas).map(([name, inputSchema]) => ({
      name,
      description: descriptions[name],
      inputSchema,
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))
  config.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    try {
      if (!validators.get(name)?.(args)) throw new Error('目标工具参数不符合 JSON Schema')
      if (!handlers.onGoalToolCall) throw new Error('目标执行端不可用')
      const result = await handlers.onGoalToolCall(name, args, identity(name, args))
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }
    }
  })
  return config
}
