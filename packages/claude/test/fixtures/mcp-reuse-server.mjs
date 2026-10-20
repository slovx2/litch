#!/usr/bin/env node
// 手写的 MCP 服务（stdio，一行一条 JSON-RPC），给连接复用的用例用。每被起一次记一行 started，
// 收到的 ping、tools/list、tools/call、取消通知，连接关了，都按进程号记进 FIXTURE_LOG_PATH。
// 两个工具：echo 马上回；slow 一直不回，只等取消。环境变量：
//   FIXTURE_LIST_CHANGED=1  握手时声明 tools.listChanged
//   FIXTURE_HANG_PING=1     收到 ping 不回（模拟卡住的服务）
//   FIXTURE_DELAY_MS=N      起来之后过 N 毫秒才开始处理（模拟起得慢的服务）
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const record = (entry) =>
  appendFileSync(
    process.env.FIXTURE_LOG_PATH,
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  )
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const TOOLS = ['echo', 'slow'].map((name) => ({
  name,
  description: `fixture tool ${name}`,
  inputSchema: { type: 'object', properties: {} },
}))

record({ event: 'started' })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    record({ event: 'closed', by: signal })
    process.exit(0)
  })

const ready = new Promise((done) => setTimeout(done, Number(process.env.FIXTURE_DELAY_MS ?? 0)))
const lines = readline.createInterface({ input: process.stdin })
lines.on('close', () => record({ event: 'closed', by: 'stdin' }))
lines.on('line', async (line) => {
  await ready
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'notifications/cancelled') {
    record({ event: 'cancelled', requestId: message.params?.requestId })
    return
  }
  if (message.id === undefined || message.method === undefined) return
  if (message.method === 'initialize') {
    record({ event: 'connected' })
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: {
          tools: process.env.FIXTURE_LIST_CHANGED === '1' ? { listChanged: true } : {},
        },
        serverInfo: { name: 'reuse-fixture', version: '1.0.0' },
      },
    })
  } else if (message.method === 'ping') {
    record({ event: 'ping' })
    if (process.env.FIXTURE_HANG_PING !== '1') send({ id: message.id, result: {} })
  } else if (message.method === 'tools/list') {
    record({ event: 'listed' })
    send({ id: message.id, result: { tools: TOOLS } })
  } else if (message.method === 'tools/call') {
    record({ event: 'called', tool: message.params.name })
    if (message.params.name === 'echo')
      send({ id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
  } else send({ id: message.id, error: { code: -32601, message: `no ${message.method}` } })
})
