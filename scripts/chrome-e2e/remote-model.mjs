// 在已授权的隔离远程 HOME 启动，固定回环假模型；只执行测试提示里明确列出的工具步骤。
// 同一夹具供 Chrome 与 CU 验收，绝不连接模型供应商。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '')
if (root !== '/opt/litch-chrome' || process.env.HOME !== `${root}/home`)
  throw new Error('Remote fixture must run in the isolated HOME')
const agent = join(root, 'agent')
mkdirSync(agent, { recursive: true })
let serial = 0
const asText = (value) =>
  typeof value === 'string' ? value : (value ?? []).map((part) => part.text ?? '').join('')
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const messages = body.messages ?? []
    const userAt = messages.findLastIndex(
      (message) => message.role === 'user' && asText(message.content).includes('LITCH_TOOL_PLAN '),
    )
    const prompt = userAt < 0 ? '' : asText(messages[userAt].content)
    const rawPlan = prompt.slice(prompt.indexOf('LITCH_TOOL_PLAN ') + 16)
    const plan = userAt < 0 ? [] : JSON.parse(rawPlan)
    const after = messages.slice(userAt + 1)
    const results = after
      .filter((message) => message.role === 'tool')
      .map((message) => asText(message.content))
    const step = plan[results.length]
    let delta, finish
    if (step) {
      const history = results.join('\n')
      const substitutes = {
        targetId: history.match(/"targetId"\s*:\s*"(chrome:[^"]+)"/)?.[1],
        tabId: [...history.matchAll(/"tabId"\s*:\s*"(chrome:[^"]+)"/g)].at(-1)?.[1],
      }
      const serialized = JSON.stringify(step.args ?? {}).replace(
        /"\$(targetId|tabId)"/g,
        (_match, key) => JSON.stringify(substitutes[key] ?? 'missing'),
      )
      const name = `client_${createHash('sha256')
        .update(JSON.stringify([step.namespace ?? 'litch_browser', step.tool]))
        .digest('hex')
        .slice(0, 32)}`
      if (!(body.tools ?? []).some((tool) => tool.function?.name === name))
        throw new Error(`Tool is unavailable: ${step.tool}`)
      delta = {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `remote_${++serial}`,
            type: 'function',
            function: { name, arguments: serialized },
          },
        ],
      }
      finish = 'tool_calls'
    } else {
      delta = { role: 'assistant', content: `LITCH_REMOTE_DONE\n${results.join('\n')}` }
      finish = 'stop'
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const emit = (delta, finish_reason) =>
      res.write(
        `data: ${JSON.stringify({ id: `fixture_${serial}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      )
    emit(delta, null)
    emit({}, finish)
    res.end('data: [DONE]\n\n')
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
writeFileSync(
  join(agent, 'models.json'),
  JSON.stringify({
    providers: {
      gate: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'fixture-only',
        models: [
          {
            id: 'gate',
            name: 'Isolated fixture',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
)
writeFileSync(
  join(agent, 'settings.json'),
  JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
)
writeFileSync(join(root, 'model-ready.json'), JSON.stringify({ pid: process.pid, port }))
console.log(`ISOLATED_MODEL ${port}`)
