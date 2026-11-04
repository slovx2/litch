// 只供测试的进程：通过真实 stdio framing 和 WS 鉴权发送固定协议消息。

import type { IncomingMessage } from 'node:http'
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: 0,
  verifyClient: (info: { req: IncomingMessage }) =>
    info.req.headers['x-goog-api-key'] === 'local-test-token',
})
await new Promise<void>((resolve) => wss.once('listening', resolve))
const address = wss.address()
if (!address || typeof address === 'string') throw new Error('port')
const port: number[] = []
let value = address.port
do {
  port.push((value & 127) | (value > 127 ? 128 : 0))
  value >>>= 7
} while (value)
const data = Buffer.concat([Buffer.from([8, ...port, 18, 16]), Buffer.from('local-test-token')])
const header = Buffer.alloc(4)
header.writeUInt32LE(data.length)
process.stdin.once('data', () => {
  const bytes = Buffer.concat([header, data])
  process.stdout.write(bytes.subarray(0, 3))
  setTimeout(() => process.stdout.write(bytes.subarray(3)), 10)
})
wss.on('connection', (ws) => {
  let id = ''
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const send = (event: unknown) => ws.send(JSON.stringify(event))
    if (message.config) {
      id = message.config.cascadeId
      send({ initializeConversationResponse: { cascadeId: id } })
    }
    if (message.userInput) {
      send({ trajectoryStateUpdate: { trajectoryId: id, state: 'STATE_RUNNING' } })
      for (const [state, text, textDelta] of [
        ['STATE_ACTIVE', 'mock', 'mock'],
        ['STATE_DONE', 'mock answer', ' answer'],
      ])
        send({
          stepUpdate: {
            trajectoryId: id,
            stepIndex: 1,
            state,
            source: 'SOURCE_MODEL',
            target: 'TARGET_USER',
            text,
            textDelta,
          },
        })
      send({ trajectoryStateUpdate: { trajectoryId: id, state: 'STATE_FULLY_IDLE' } })
    }
  })
})
