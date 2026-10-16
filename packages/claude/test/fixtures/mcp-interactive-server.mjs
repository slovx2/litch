import { appendFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// 真实 CLI 通过 stdio 启动；只有用户接受表单后才写入测试文件。
const server = new Server(
  { name: 'interactive-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'confirm_fixture',
      description: 'Ask for approval before writing a fixture file',
      inputSchema: { type: 'object', properties: {} },
      _meta: { 'anthropic/alwaysLoad': true },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
  const request =
    process.env.FIXTURE_ELICITATION_MODE === 'url'
      ? {
          mode: 'url',
          message: 'MCP_URL_FIXTURE',
          url: 'http://127.0.0.1/fixture',
          elicitationId: 'fixture-browser-flow',
        }
      : {
          mode: 'form',
          message: 'MCP_FORM_FIXTURE',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string', minLength: 1 } },
            required: ['value'],
          },
        }
  // 夹具自身的等待预算长于三分钟验收；不能让第三方 SDK 默认60秒掩盖产品结果。
  const response = await server.elicitInput(request, { timeout: 300_000, signal: extra.signal })
  if (response.action === 'accept') {
    const value = request.mode === 'url' ? 'URL_CONFIRMED' : response.content.value
    await appendFile(process.env.FIXTURE_EFFECT_PATH, String(value) + '\n')
  }
  return {
    content: [
      {
        type: 'text',
        text: 'MCP_ACTION_' + response.action + ' META=' + JSON.stringify(response._meta),
      },
    ],
  }
})
await server.connect(new StdioServerTransport())
