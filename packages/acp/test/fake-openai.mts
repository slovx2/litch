import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// 回环上的假 OpenAI 兼容模型（/v1/chat/completions，流式）：冒烟测试拿它给真的 agent 当模型，不发真实请求。
// 怎么答：上一条是工具结果的，说一句“命令跑完了”；用户的话里有 run-tool 的，调一次 bash；别的说一句“冒烟好了”。
export interface FakeOpenAi {
  url: string
  /** 收到的请求体 */
  requests: any[]
  close(): Promise<void>
}

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const usage = `data: ${JSON.stringify({
  id: 'chatcmpl-fake',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake-model',
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
})}\n\n`

const textOf = (message: any): string =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part: any) => part?.text ?? '').join('')
      : ''

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: any[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (part: string) => {
      body += part
    })
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `fake: no ${request.url}` } }))
        return
      }
      const parsed = JSON.parse(body || '{}')
      requests.push(parsed)
      const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : []
      const last = messages.at(-1)
      const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (last?.role !== 'tool' && textOf(lastUser).includes('run-tool') && parsed.tools?.length) {
        response.write(chunk({ role: 'assistant', content: '' }))
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_fake_1',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'echo smoke', description: '回显一句' }),
                },
              },
            ],
          }),
        )
        response.write(chunk({}, 'tool_calls'))
      } else {
        const said = last?.role === 'tool' ? '命令跑完了' : '冒烟好了'
        response.write(chunk({ role: 'assistant', content: said }))
        response.write(chunk({}, 'stop'))
      }
      response.write(usage)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
