import { appendFile, readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const marker = process.env.FIXTURE_MARKER ?? 'DEFAULT'
const server = new Server(
  { name: marker, version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
)
const tool = (name) => ({
  name,
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
})
server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  request.params?.cursor
    ? { tools: [tool('fail')] }
    : { tools: [tool('append')], nextCursor: 'tools-second' },
)
server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
  request.params?.cursor
    ? { resources: [{ name: 'second', uri: 'fixture://second' }] }
    : { resources: [{ name: 'first', uri: 'fixture://first' }], nextCursor: 'resources-second' },
)
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ name: 'template', uriTemplate: 'fixture://{name}' }],
}))
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: marker }],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'fail')
    return { content: [{ type: 'text', text: 'FIXTURE_TOOL_ERROR' }], isError: true }
  const value = request.params.arguments?.value
  if (typeof value !== 'string') throw new Error('value 必须是字符串')
  await appendFile(process.env.FIXTURE_EFFECT_PATH, value + '\n')
  return {
    content: [{ type: 'text', text: marker }],
    structuredContent: {
      marker,
      content: await readFile(process.env.FIXTURE_EFFECT_PATH, 'utf8'),
    },
    isError: false,
    _meta: request.params._meta,
  }
})
await server.connect(new StdioServerTransport())
