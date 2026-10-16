import { createServer, type Server } from 'node:http'

// 回环 mock：Anthropic Messages 形态的 SSE 服务。传脚本时带工具的请求按顺序应答，不带工具的请求（dsh 生成标题）
// 固定回一句标题；传应答函数时全部请求都交给它按内容决定。其余路径（文件上传等）回 404。
export type MockBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; chunks: string[]; delayMs?: number }
  | { type: 'tool_use'; name: string; input: unknown }
export interface MockModel {
  url: string
  requests: any[]
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type MockResponder = (body: any) => MockBlock[]

// 假模型按用户那句话里的记号作答：每个记号对应一串步骤，模型每拿到一次工具结果就走下一步，
// 步骤用完了收尾。请求可能交错到达（生成标题、插话之后的续跑），所以按请求内容算走到第几步，不按到达顺序。
// 一条用户消息里有好几个记号时认最后出现的那个：被打断的回合要是已经记下了用户的话，
// 下一回合的请求里它和新的一句并在同一条消息里。
export function scripted(scripts: Record<string, MockBlock[][]>): MockResponder {
  return (body: any): MockBlock[] => {
    const messages: any[] = body.messages ?? []
    const textOf = (message: any): string =>
      typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content : [])
            .map((block: any) => (block.type === 'text' ? block.text : ''))
            .join('\n')
    const isPrompt = (message: any) =>
      message.role === 'user' &&
      !(Array.isArray(message.content) ? message.content : []).some(
        (block: any) => block.type === 'tool_result',
      )
    const asked = messages.findLastIndex(isPrompt)
    const prompt = asked < 0 ? '' : textOf(messages[asked])
    const step = messages.slice(asked + 1).filter((message) => message.role === 'assistant').length
    const key = Object.keys(scripts)
      .filter((marker) => prompt.includes(marker))
      .sort((a, b) => prompt.lastIndexOf(b) - prompt.lastIndexOf(a))[0]
    return (key ? scripts[key]?.[step] : undefined) ?? [{ type: 'text', chunks: ['好的。'] }]
  }
}

export async function startMockModel(script: MockBlock[][] | MockResponder): Promise<MockModel> {
  const requests: any[] = []
  let cursor = 0
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    if (request.method !== 'POST' || !String(request.url).endsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    requests.push(body)
    const blocks: MockBlock[] =
      typeof script === 'function'
        ? script(body)
        : body.tools?.length
          ? (script[cursor++] ?? [{ type: 'text', chunks: ['脚本已用尽'] }])
          : [{ type: 'text', chunks: ['mock 标题'] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('message_start', {
      message: {
        id: `msg_mock_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 },
      },
    })
    let index = 0
    for (const block of blocks) {
      if (block.type === 'thinking') {
        emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } })
        emit('content_block_delta', {
          index,
          delta: { type: 'thinking_delta', thinking: block.text },
        })
        emit('content_block_delta', {
          index,
          delta: { type: 'signature_delta', signature: 'mock' },
        })
      } else if (block.type === 'text') {
        emit('content_block_start', { index, content_block: { type: 'text', text: '' } })
        for (const piece of block.chunks) {
          emit('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
          if (block.delayMs) await sleep(block.delayMs)
        }
      } else {
        const id = `toolu_mock_${requests.length}_${index}`
        emit('content_block_start', {
          index,
          content_block: { type: 'tool_use', id, name: block.name, input: {} },
        })
        emit('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        })
      }
      emit('content_block_stop', { index })
      index += 1
    }
    emit('message_delta', {
      delta: {
        stop_reason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 20 },
    })
    emit('message_stop', {})
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/anthropic`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
