import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

// 测试用的假 dsh：只有 DshRuntime 起它、连它用得到的那一点（版本号、就绪行、令牌换 cookie、事件流的就绪帧），
// 外加照真的 dsh 0.2.0-rc.2 对结束信号的反应：头一个信号先断开 Web Remote 的连接再收尾，收尾完了退出；
// 收尾途中再来一个，丢下收尾立刻退出。经过记成一行一条的 JSON（FAKE_DSH_LOG），用例拿来对。
//   FAKE_DSH_WIND_DOWN_MS   收尾要多久
//   FAKE_DSH_STUCK=1        收了信号不收场（卡死的 dsh）
//   FAKE_DSH_NO_COOKIE=1    启动令牌换不到 cookie（连不上的 dsh）
//   FAKE_DSH_DROP_MS        连上之后过这么久把连接断开，进程照常跑着（连接断了、却没在收场的 dsh）

const record = (entry: object): void => {
  const path = process.env.FAKE_DSH_LOG
  if (path) appendFileSync(path, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

if (process.argv.includes('--version')) {
  process.stdout.write('0.2.0-rc.2\n')
  process.exit(0)
}

const server = createServer((request, response) => {
  if (request.method === 'GET') {
    if (process.env.FAKE_DSH_NO_COOKIE === '1') response.writeHead(403).end()
    else response.writeHead(303, { location: '/', 'set-cookie': 'fake=1; Path=/' }).end()
    return
  }
  request.resume()
  request.on('end', () =>
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ result: { ok: true, value: { items: [] } } })),
  )
})
const sockets = new WebSocketServer({ server, path: '/api/remote.mux' })
sockets.on('connection', (socket) => {
  if (process.env.FAKE_DSH_DROP_MS)
    setTimeout(() => socket.close(1011), Number(process.env.FAKE_DSH_DROP_MS))
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    if (frame.type === 'open' && frame.endpoint === '$events')
      socket.send(
        JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: { type: 'ready', clientId: 'fake' },
        }),
      )
  })
})

let signals = 0
process.on('SIGTERM', () => {
  signals += 1
  record({ event: 'signal', count: signals })
  if (signals > 1) {
    record({ event: 'exit', how: 'cut' })
    process.exit(0)
  }
  if (process.env.FAKE_DSH_STUCK === '1') return
  for (const socket of sockets.clients) socket.close(1001)
  setTimeout(
    () => {
      record({ event: 'exit', how: 'clean' })
      process.exit(0)
    },
    Number(process.env.FAKE_DSH_WIND_DOWN_MS ?? 50),
  )
})

server.listen(0, '127.0.0.1', () => {
  record({ event: 'start' })
  process.stdout.write(
    `dsh web: http://127.0.0.1:${(server.address() as AddressInfo).port}/?launch=fake\n`,
  )
})
