import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  type PermissionGrant,
  type PermissionProposal,
  parsePermissionProposal,
} from './permission-grants.mjs'

const pathList = {
  anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }],
}
const profileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    network: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: ['boolean', 'null'] } },
    },
    fileSystem: {
      type: 'object',
      additionalProperties: false,
      properties: { read: pathList, write: pathList },
    },
  },
}

// Tyrs Hand 自有真实 MCP 工具；不冒充 Claude 内建工具。
export function permissionToolServer(
  request: (proposal: PermissionProposal, callId: string) => Promise<PermissionGrant>,
  identity: (args: unknown) => string,
) {
  const config = createSdkMcpServer({ name: 'codex_harness_adapter_permissions', version: '1.0.0' })
  config.instance.server.registerCapabilities({ tools: {} })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'request_permissions',
        description:
          'Tyrs Hand 权限申请：向用户明确请求新增的现有绝对路径读写权限或网络权限。等待返回后仅使用实际获准范围；拒绝不代表成功。session 仅在当前运行代的同一会话跨回合有效，重启后失效。不能替代退出计划确认。',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['permissions'],
          properties: { permissions: profileSchema, reason: { type: ['string', 'null'] } },
        },
        _meta: { 'anthropic/alwaysLoad': true },
      },
    ],
  }))
  config.instance.server.setRequestHandler(CallToolRequestSchema, async (message) => {
    try {
      if (message.params.name !== 'request_permissions') throw new Error('未知权限工具')
      const args = message.params.arguments ?? {}
      const callId = identity(args)
      const result = await request(parsePermissionProposal(args), callId)
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
