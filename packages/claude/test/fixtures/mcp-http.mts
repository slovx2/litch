import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { reclaimAtEnd } from './reclaim.mjs'

export class LocalMcp {
  calls = 0
  errors: string[] = []
  constructor(privateCall: () => Promise<void>) {
    this.call = privateCall
  }
  private call: () => Promise<void>
  private reclaimed: (() => void) | undefined
  private closing: Promise<void> | undefined
  private server = createServer(async (req, res) => {
    if (
      req.headers.authorization !== 'Bearer test-not-a-secret' ||
      req.headers['x-runtime'] !== 'claude-fixture'
    ) {
      this.errors.push('MCP header 未正确转发')
      res.writeHead(401).end()
      return
    }
    const server = new Server(
      { name: 'fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'touch_fixture',
          description: 'Write the test fixture file',
          inputSchema: { type: 'object', properties: {} },
          _meta: { 'anthropic/alwaysLoad': true },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => {
      this.calls++
      await this.call()
      return { content: [{ type: 'text', text: 'MCP_FILE_WRITTEN' }] }
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.on('close', () => {
      void server.close()
    })
    try {
      // SDK 1.29.0 的 class/Transport 对可选回调的声明在 exactOptionalPropertyTypes 下不一致。
      await server.connect(transport as unknown as Parameters<Server['connect']>[0])
      await transport.handleRequest(req, res)
    } catch (error) {
      this.errors.push(String(error))
      if (!res.headersSent) res.writeHead(500)
      res.end()
      await server.close()
    }
  })
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.reclaimed = reclaimAtEnd(() => this.close())
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('MCP 地址无效')
    return `http://127.0.0.1:${address.port}/mcp`
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }
  private async shutdown(): Promise<void> {
    this.reclaimed?.()
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
