import { createServer, type Server } from 'node:http'

// 回环上的假 OpenAI 兼容模型（/v1/chat/completions 的流式应答），给测试里的 opencode 用：不发真实模型请求。
// 应答按脚本：用户最近那句话里含哪个记号，就走那个记号的步骤；模型每拿到一次工具结果就走下一步，步骤用完了收尾。
// 请求可能交错到达（生成标题、插话之后的续跑），所以按请求内容算走到第几步，不按到达顺序。
// 不带工具的请求（OpenCode 起标题、压缩时的摘要）固定回一句话。

export type MockBlock =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; chunks: string[]; delayMs?: number }
  | { type: 'tool'; name: string; input: unknown }
  // 应答前先等一会儿（模拟慢模型，打断、插话的用例用）
  | { type: 'wait'; ms: number }

export type MockResponder = (body: any) => MockBlock[]

export interface MockModel {
  url: string
  requests: any[]
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const textOf = (message: any): string =>
  typeof message?.content === 'string'
    ? message.content
    : (Array.isArray(message?.content) ? message.content : [])
        .map((part: any) => (part?.type === 'text' ? part.text : ''))
        .join('\n')

/** 按记号写的脚本：{ 记号: [第一步, 第二步, ...] }，一步是模型一次应答里的几块 */
export function scripted(scripts: Record<string, MockBlock[][]>): MockResponder {
  return (body: any): MockBlock[] => {
    const messages: any[] = body.messages ?? []
    const asked = messages.findLastIndex((message) => message.role === 'user')
    // 用户的话可能被 OpenCode 拆成几条（插话、系统提醒），往前把连着的用户消息都算上
    let start = asked
    while (start > 0 && messages[start - 1]?.role === 'user') start -= 1
    const prompt = messages
      .slice(Math.max(0, start), asked + 1)
      .map(textOf)
      .join('\n')
    const step = messages.slice(asked + 1).filter((message) => message.role === 'assistant').length
    const key = Object.keys(scripts)
      .filter((marker) => prompt.includes(marker))
      .sort((a, b) => prompt.lastIndexOf(b) - prompt.lastIndexOf(a))[0]
    return (key ? scripts[key]?.[step] : undefined) ?? [{ type: 'text', chunks: ['好的。'] }]
  }
}

export async function startMockModel(respond: MockResponder): Promise<MockModel> {
  const requests: any[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'm1', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !String(request.url).endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    requests.push(body)
    const blocks: MockBlock[] = body.tools?.length
      ? respond(body)
      : [{ type: 'text', chunks: ['mock 标题'] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `mock-${requests.length}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      )
    emit({ role: 'assistant' })
    let calls = 0
    for (const block of blocks) {
      if (response.destroyed) break
      if (block.type === 'wait') await sleep(block.ms)
      else if (block.type === 'reasoning') emit({ reasoning_content: block.text })
      else if (block.type === 'text')
        for (const piece of block.chunks) {
          emit({ content: piece })
          if (block.delayMs) await sleep(block.delayMs)
        }
      else {
        const index = calls++
        const args = JSON.stringify(block.input)
        emit({
          tool_calls: [
            {
              index,
              id: `call_${requests.length}_${index}`,
              type: 'function',
              function: { name: block.name, arguments: '' },
            },
          ],
        })
        emit({ tool_calls: [{ index, function: { arguments: args } }] })
      }
    }
    emit({}, calls ? 'tool_calls' : 'stop')
    response.write(
      `data: ${JSON.stringify({
        id: `mock-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
