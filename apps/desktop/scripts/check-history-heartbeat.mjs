// 真实 WebSocket 单帧52MB慢传：跨过原来的35秒误断点；另验完全无回音时仍断开。
// 只用回环、内存打包，不保存截图、报告或用户数据。Node 24运行。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { Duplex, Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { WebSocket, WebSocketServer } from 'ws'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/transport-ws.mts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
)
const { wrapSocket } = module.exports

async function run(slow) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: slow })
  await new Promise((resolve) => server.once('listening', resolve))
  let peer
  server.on('connection', (socket) => {
    peer = socket
    socket.on('message', () => {
      if (slow) socket.send('x'.repeat(52_000_000))
    })
  })
  const tcp = net.connect(server.address().port, '127.0.0.1')
  let activity = () => {},
    timer,
    bytes = 0
  // 计量在转换内部完成，避免给同一 readable 同时添加 data监听和异步迭代读取。
  const input = new Transform({
    transform(chunk, _encoding, callback) {
      const deliver = () => {
        bytes += chunk.length
        activity()
        this.push(chunk)
        callback()
      }
      if (slow) timer = setTimeout(deliver, (chunk.length / 1_200_000) * 1000)
      else deliver()
    },
  })
  tcp.pipe(input)
  const socket = new WebSocket('ws://heartbeat.invalid/', {
    createConnection: () => Duplex.from({ readable: input, writable: tcp }),
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false,
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const start = performance.now()
  const transport = wrapSocket(socket, {
    heartbeat: slow ? { everyMs: 20_000, timeoutMs: 15_000 } : { everyMs: 100, timeoutMs: 150 },
    activity(received) {
      activity = received
      return () => {
        activity = () => {}
      }
    },
  })
  let limit
  try {
    const outcome = await new Promise((resolve, reject) => {
      limit = setTimeout(() => reject(new Error('夹具等待超时')), slow ? 65_000 : 5000)
      transport.listen({
        message(text) {
          resolve({ type: 'message', length: text.length })
        },
        close(reason) {
          resolve({ type: 'close', reason })
        },
      })
      transport.send('read')
    })
    const ms = performance.now() - start
    if (slow) {
      assert.equal(outcome.type, 'message', '持续收包时不应被心跳断开')
      assert.equal(outcome.length, 52_000_000)
      assert.ok(ms > 35_000, '必须跨过旧版误断点')
    } else {
      assert.equal(outcome.type, 'close')
      assert.equal(outcome.reason.key, 'connect.heartbeat')
      assert.ok(ms < 2000)
    }
    console.log(JSON.stringify({ slow, ms, bytes, ...outcome }))
  } finally {
    clearTimeout(limit)
    clearTimeout(timer)
    transport.close()
    socket.terminate()
    peer?.terminate()
    tcp.destroy()
    input.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}
await run(true)
await run(false)
