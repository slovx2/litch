#!/usr/bin/env node
// 手写的 MCP 服务（stdio，一行一条 JSON-RPC），不用任何 MCP 库：对面看到的就是线上的原样，
// 没有库替它校验或补字段。只有一个工具，被调用时向客户端发 elicitation/create，
// 征询的内容由测试经环境变量给（FIXTURE_ELICITATION，一段 JSON）；等到答复，把答复原样写进工具结果。
// 线上来往的每一条都按先后记进 FIXTURE_LOG_PATH（一行一条，带着这个服务自己的进程号），
// 测试拿它断言“服务这一头实际收到了什么”，也据进程号看这个服务还在不在。
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const ELICITATION = JSON.parse(process.env.FIXTURE_ELICITATION)
const TOOL = {
  name: 'ask_form',
  description: 'Ask the user to fill in a form, then return what they answered',
  inputSchema: { type: 'object', properties: {} },
  // 让 CLI 一开始就把这个工具交给模型，不放到“用到再找”的那一批里
  _meta: { 'anthropic/alwaysLoad': true },
}

const record = (from, message) =>
  appendFileSync(
    process.env.FIXTURE_LOG_PATH,
    `${JSON.stringify({ from, message, pid: process.pid })}\n`,
  )

function send(message) {
  const framed = { jsonrpc: '2.0', ...message }
  record('server', framed)
  process.stdout.write(`${JSON.stringify(framed)}\n`)
}

/** 发出去还没有答复的征询：征询的请求号 → 是哪一次工具调用发的 */
const asking = new Map()
let sequence = 0

const lines = readline.createInterface({ input: process.stdin })
// 对面把连接关了（标准输入到头）：记一笔，测试据此知道挂着的征询是不是随连接一起作废的
lines.on('close', () => record('fixture', { closed: true, unanswered: [...asking.keys()] }))
lines.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  record('client', message)
  if (message.method === undefined) {
    // 客户端对征询的答复：原样写进那次工具调用的结果
    const call = asking.get(message.id)
    if (call === undefined) return
    asking.delete(message.id)
    const answer = message.error ? { error: message.error } : message.result
    send({
      id: call,
      result: { content: [{ type: 'text', text: `ELICITED ${JSON.stringify(answer)}` }] },
    })
    return
  }
  // 通知（initialized、cancelled）记下来就行
  if (message.id === undefined) return
  if (message.method === 'initialize')
    send({
      id: message.id,
      result: {
        // 客户端要哪一版就说哪一版
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'elicit-fixture', version: '1.0.0' },
      },
    })
  else if (message.method === 'ping') send({ id: message.id, result: {} })
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [TOOL] } })
  else if (message.method === 'tools/call') {
    const id = `elicit-${++sequence}`
    asking.set(id, message.id)
    send({ id, method: 'elicitation/create', params: ELICITATION })
  } else
    send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    })
})
