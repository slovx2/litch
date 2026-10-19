import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// 回环上的假 Gemini API（generativelanguage 的 v1beta）：冒烟测试拿它给真的 gemini --acp 当模型
//（GOOGLE_GEMINI_BASE_URL 指过来，GEMINI_API_KEY 随便填），不发真实请求、不用登录。
// 怎么答（流式的 streamGenerateContent）：上一条是工具结果的，说“工具调完了”；声明的工具里有名字对得上 callTool 的，
// 调它一次（参数 callArgs；MCP 工具的名字各版本拼法不一样，所以按条件认）；别的说一句“冒烟好了”。不流式的 generateContent 是 Gemini CLI 自己的小判断
//（下一个该谁说、选哪个模型、题目难不难），答一个几种都能解析的 JSON。
export interface FakeGemini {
  url: string
  /** 收到的流式请求的请求体（发给模型的那几次） */
  requests: any[]
  /** 收到的每个请求的方法和地址（查问题用） */
  urls: string[]
  close(): Promise<void>
}

const candidate = (parts: object[]) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
})

export async function startFakeGemini(
  callTool: (name: string) => boolean,
  callArgs: object,
): Promise<FakeGemini> {
  const requests: any[] = []
  const urls: string[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = request.url ?? ''
      urls.push(`${request.method} ${url}`)
      let body: any = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {}
      if (url.includes(':countTokens')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ totalTokens: 10 }))
        return
      }
      if (!url.includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            candidate([
              {
                text: JSON.stringify({
                  reasoning: '冒烟',
                  next_speaker: 'user',
                  model_choice: 'flash',
                  complexity_reasoning: '冒烟',
                  complexity_score: 10,
                }),
              },
            ]),
          ),
        )
        return
      }
      requests.push(body)
      const contents: any[] = Array.isArray(body.contents) ? body.contents : []
      const last = contents.at(-1)
      const answered = (last?.parts ?? []).some((part: any) => part?.functionResponse)
      const declared = (body.tools ?? [])
        .flatMap((tool: any) => tool?.functionDeclarations ?? [])
        .map((fn: any) => String(fn?.name ?? ''))
        .find(callTool)
      const parts = answered
        ? [{ text: '工具调完了' }]
        : declared
          ? [{ functionCall: { name: declared, args: callArgs } }]
          : [{ text: '冒烟好了' }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify(candidate(parts))}\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
