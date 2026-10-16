import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  type AnySchema,
  type SchemaOutput,
  safeParse,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  ProgressNotificationSchema,
  type Request,
} from '@modelcontextprotocol/sdk/types.js'

interface PendingTool {
  finish(message?: JSONRPCMessage, error?: Error): void
  progress: RequestOptions['onprogress']
}

// 固定 MCP SDK 的 request() 无法关闭计时器。工具请求通过公开 transport 等待，
// 握手和管理请求仍由 SDK 处理，callTool 的输出 schema 校验也继续使用 SDK。
export class NativeMcpClient extends Client {
  private readonly prefix = `codex-harness-adapter-tool-${randomUUID()}-`
  private sequence = 0
  private readonly waiting = new Map<string, PendingTool>()

  override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
    await super.connect(transport, options)
    const onmessage = transport.onmessage
    const onclose = transport.onclose
    transport.onmessage = (message, extra) => {
      if ('id' in message && typeof message.id === 'string' && !('method' in message)) {
        if (message.id.startsWith(this.prefix)) {
          this.waiting.get(message.id)?.finish(message)
          return
        }
      }
      if ('method' in message && message.method === 'notifications/progress') {
        const token = message.params?.progressToken
        if (typeof token === 'string' && token.startsWith(this.prefix)) {
          try {
            this.waiting.get(token)?.progress?.(ProgressNotificationSchema.parse(message).params)
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
      }
      onmessage?.(message, extra)
    }
    transport.onclose = () => {
      for (const pending of this.waiting.values())
        pending.finish(undefined, new McpError(ErrorCode.ConnectionClosed, 'MCP 连接已关闭'))
      onclose?.()
    }
  }

  override request<T extends AnySchema>(
    request: Request,
    schema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (
      request.method !== 'tools/call' ||
      options?.timeout !== undefined ||
      options?.maxTotalTimeout !== undefined ||
      options?.task ||
      options?.relatedTask
    )
      return super.request(request, schema, options)
    const transport = this.transport
    if (!transport) return Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'MCP 未连接'))
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason)
    this.assertCapabilityForMethod(request.method)
    const id = `${this.prefix}${++this.sequence}`
    return new Promise((resolve, reject) => {
      const finish = (message?: JSONRPCMessage, error?: Error) => {
        if (!this.waiting.delete(id)) return
        options?.signal?.removeEventListener('abort', cancel)
        if (error) return reject(error)
        if (message && 'error' in message)
          return reject(new McpError(message.error.code, message.error.message, message.error.data))
        try {
          const result = safeParse(
            schema,
            message && 'result' in message ? message.result : undefined,
          )
          if (!result.success) reject(result.error)
          else resolve(result.data as SchemaOutput<T>)
        } catch (error) {
          reject(error)
        }
      }
      const cancel = () => {
        finish(undefined, options?.signal?.reason ?? new Error('MCP 工具请求已取消'))
        void transport
          .send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'MCP 工具请求已取消' },
          })
          .catch((error) => this.onerror?.(error))
      }
      this.waiting.set(id, { finish, progress: options?.onprogress })
      options?.signal?.addEventListener('abort', cancel, { once: true })
      const params = options?.onprogress
        ? { ...request.params, _meta: { ...request.params?._meta, progressToken: id } }
        : request.params
      try {
        void transport
          .send({ ...request, ...(params ? { params } : {}), jsonrpc: '2.0', id }, options)
          .catch((error) => finish(undefined, error))
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
