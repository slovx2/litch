import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { saveArtifact } from './artifacts.mjs'
import { reclaimAtEnd } from './reclaim.mjs'

export type ModelRequest = Record<string, any>
export type ModelReply =
  | Array<Record<string, unknown>>
  | { content: Array<Record<string, unknown>>; headers: Record<string, string> }
  | { status: number; message: string; errorType?: string; headers?: Record<string, string> }
  | { disconnect: true }
  | { disconnectAfterText: string; afterDelta: () => Promise<void> }
export type ModelStep = (
  request: ModelRequest,
  headers: IncomingHttpHeaders,
) => ModelReply | Promise<ModelReply>

// 只替换模型 HTTP 接口。SDK、CLI、工具及会话文件都使用真实实现。
export class MockLLM {
  readonly requests: ModelRequest[] = []
  readonly unexpected: string[] = []
  // 计划之外的请求由它应答。只用于时机不由测试控制的请求，例如后台命令结束后 CLI 自行续跑。
  fallback: ModelStep | null = null
  private steps: ModelStep[] = []
  private reclaimed: (() => void) | undefined
  private closing: Promise<void> | undefined
  private server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as ModelRequest
      if (req.url === '/api/hello') {
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
        return
      }
      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      const responsesAPI = req.url?.startsWith('/v1/responses') === true
      if (!req.url?.startsWith('/v1/messages') && !responsesAPI) {
        this.unexpected.push(req.url ?? '')
        res.writeHead(404).end()
        return
      }
      this.requests.push(body)
      const step = this.steps.shift() ?? this.fallback
      if (!step) throw new Error('收到未计划的模型请求')
      const reply = await step(body, req.headers)
      if (!Array.isArray(reply) && !('content' in reply)) {
        if ('disconnectAfterText' in reply) {
          if (responsesAPI || !body.stream) throw new Error('有效半断流必须使用 Claude 原生 SSE')
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          this.event(res, 'message_start', {
            message: {
              id: `msg_${randomUUID()}`,
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          })
          this.event(res, 'content_block_start', {
            index: 0,
            content_block: { type: 'text', text: '' },
          })
          this.event(res, 'content_block_delta', {
            index: 0,
            delta: { type: 'text_delta', text: reply.disconnectAfterText },
          })
          // 等实际客户端收到增量后再断开，避免只测到还未送达数据的连接失败。
          await reply.afterDelta()
          res.socket?.destroy()
        } else if ('disconnect' in reply) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('event: message_start\ndata: {')
          res.socket?.destroy()
        } else {
          res.writeHead(reply.status, {
            'Content-Type': 'application/json',
            'Retry-After': '0',
            ...reply.headers,
          })
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type:
                  reply.errorType ??
                  (reply.status === 401
                    ? 'authentication_error'
                    : reply.status === 429
                      ? 'rate_limit_error'
                      : 'api_error'),
                message: reply.message,
              },
            }),
          )
        }
        return
      }
      const content = Array.isArray(reply) ? reply : reply.content
      if (!Array.isArray(reply))
        for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value)
      if (responsesAPI) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const id = `resp_${randomUUID()}`
        this.event(res, 'response.created', { response: { id } })
        for (const item of content) {
          const output =
            item.type === 'tool_use'
              ? {
                  type: 'function_call',
                  call_id: item.id,
                  namespace: item.namespace ?? null,
                  name: item.name,
                  arguments: JSON.stringify(item.input),
                }
              : {
                  type: 'message',
                  id: `msg_${randomUUID()}`,
                  role: 'assistant',
                  content: [{ type: 'output_text', text: item.text }],
                }
          this.event(res, 'response.output_item.done', { item: output })
        }
        this.event(res, 'response.completed', {
          response: {
            id,
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
              input_tokens_details: null,
              output_tokens_details: null,
            },
          },
        })
        res.end()
        return
      }
      const stop = content.some((item) => item.type === 'tool_use') ? 'tool_use' : 'end_turn'
      const message = {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(message))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      this.event(res, 'message_start', { message: { ...message, content: [], stop_reason: null } })
      // pauseAfterMs 只影响流式时序（模拟模型持续思考），不会写入发回的内容块。
      for (const [index, item] of content.entries()) {
        const block =
          item.type === 'text'
            ? { type: 'text', text: '' }
            : item.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { ...item, input: {} }
        this.event(res, 'content_block_start', { index, content_block: block })
        const delta =
          item.type === 'text'
            ? { type: 'text_delta', text: item.text }
            : item.type === 'thinking'
              ? { type: 'thinking_delta', thinking: item.thinking }
              : { type: 'input_json_delta', partial_json: JSON.stringify(item.input) }
        this.event(res, 'content_block_delta', { index, delta })
        this.event(res, 'content_block_stop', { index })
        if (typeof item.pauseAfterMs === 'number')
          await new Promise((resolve) => setTimeout(resolve, item.pauseAfterMs as number))
      }
      this.event(res, 'message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: message.usage,
      })
      this.event(res, 'message_stop', {})
      res.end()
    } catch (error) {
      this.unexpected.push(String(error))
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }),
      )
    }
  })
  private event(res: ServerResponse, type: string, body: Record<string, unknown>): void {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`)
  }
  enqueue(step: ModelStep): void {
    this.steps.push(step)
  }
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.reclaimed = reclaimAtEnd(() => this.close())
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Mock LLM 地址无效')
    return `http://127.0.0.1:${address.port}`
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }
  private async shutdown(): Promise<void> {
    this.reclaimed?.()
    await saveArtifact('model-requests', { requests: this.requests, unexpected: this.unexpected })
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  assertConsumed(): void {
    if (this.steps.length || this.unexpected.length)
      throw new Error(JSON.stringify({ remaining: this.steps.length, unexpected: this.unexpected }))
  }
}
