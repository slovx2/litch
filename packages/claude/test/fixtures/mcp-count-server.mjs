#!/usr/bin/env node
// 手写的 MCP 服务（stdio，一行一条 JSON-RPC），用来数“这个服务被起了几份、各是谁连的”：
// 每被起一次往 FIXTURE_LOG_PATH 记一行 started，握手时记是谁连的，工具被调用时记是哪个工具，
// 连接关了或者被信号结束也记一行。每行都带进程号，测试按进程号把同一份的几行对起来。
// 工具的名字由 FIXTURE_TOOLS 给（一段 JSON 数组，缺省只有 echo），调用时把工具名原样回出去。
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const record = (entry) =>
  appendFileSync(
    process.env.FIXTURE_LOG_PATH,
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  )
const TOOLS = JSON.parse(process.env.FIXTURE_TOOLS ?? '["echo"]').map((name) => ({
  name,
  description: `Echo back which tool was called (${name})`,
  inputSchema: { type: 'object', properties: {} },
  // 让 CLI 一开始就把这些工具交给模型，不放到“用到再找”的那一批里
  _meta: { 'anthropic/alwaysLoad': true },
}))

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

record({ event: 'started' })
// CLI 收场时是发信号结束它连的服务，不是先关标准输入
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    record({ event: 'closed', by: signal })
    process.exit(0)
  })

const lines = readline.createInterface({ input: process.stdin })
lines.on('close', () => record({ event: 'closed', by: 'stdin' }))
lines.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  // 通知和对面的应答都不用管
  if (message.id === undefined || message.method === undefined) return
  if (message.method === 'initialize') {
    record({ event: 'connected', client: message.params.clientInfo?.name })
    send({
      id: message.id,
      result: {
        // 客户端要哪一版就说哪一版
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'count-fixture', version: '1.0.0' },
      },
    })
  } else if (message.method === 'ping') send({ id: message.id, result: {} })
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: TOOLS } })
  else if (message.method === 'tools/call') {
    record({ event: 'called', tool: message.params.name })
    send({
      id: message.id,
      result: { content: [{ type: 'text', text: `CALLED ${message.params.name}` }] },
    })
  } else
    send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    })
})
