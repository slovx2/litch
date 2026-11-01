import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** 每个 TUI 会话独占的 MCP 连接；外部 MCP 的租约仍由 NativeMcpBridge 管。 */
export class TuiMcp {
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly transport: Transport
  private readonly server: McpSdkServerConfigWithInstance['instance']

  constructor(server: McpSdkServerConfigWithInstance['instance']) {
    this.server = server
    this.transport = {
      start: async () => {},
      close: async () => {
        for (const request of this.pending.values()) request.reject(new Error('TUI MCP 已关闭'))
        this.pending.clear()
      },
      send: async (message) => {
        if ('id' in message && message.id != null && !('method' in message)) {
          this.pending.get(message.id)?.resolve(message)
          this.pending.delete(message.id)
        }
      },
    }
  }

  async start(): Promise<void> {
    await this.server.connect(this.transport)
  }
  async close(): Promise<void> {
    await this.server.close()
  }

  async request(message: JSONRPCMessage): Promise<unknown> {
    if (!('id' in message) || message.id == null) {
      this.transport.onmessage?.(message)
      return null
    }
    const id = message.id
    if (this.pending.has(id)) throw new Error('重复的 MCP 请求编号')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.onmessage?.(message)
    })
  }
}
