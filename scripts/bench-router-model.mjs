// 量路由层延迟用的假模型（scripts/bench-router.mjs 把它起在单独的线程里）。
// 说的是 OpenAI 的流式对话接口，只在回环上听。每个请求按约定的条数和间隔吐增量，
// 每条增量的字就是一个记号：`流号.序号@发出时刻;`，时刻是 process.hrtime 的纳秒数，
// 和量延迟的那一头是同一个钟。放在单独的线程里，是为了吐字的节奏不被收消息的那一头拖慢。
import { createServer } from 'node:http'
import { parentPort } from 'node:worker_threads'

/** 接下来的请求各吐多少条、条与条隔多久（毫秒，0 是一条接一条不等） */
let plan = { deltas: 1, intervalMs: 0 }
let streams = 0

const tick = () => new Promise((done) => setImmediate(done))
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const stream = ++streams
  const { deltas, intervalMs } = plan
  // 每个请求用完就关连接：运行时会复用空闲连接，而这一头的空闲连接过 5 秒会自己关，
  // 机器忙的时候两边撞上，运行时那个回合就以“Connection error.”失败
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  // 每条增量各自成包发走，不让系统把相邻的几条攒在一起
  res.socket?.setNoDelay(true)
  const base = { id: `bench_${stream}`, object: 'chat.completion.chunk', created: 1 }
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    )
  chunk({ role: 'assistant', content: '' })
  const started = process.hrtime.bigint()
  for (let seq = 0; seq < deltas; seq++) {
    chunk({ content: `${stream}.${seq}@${process.hrtime.bigint()};` })
    // 不等的时候也让出一次：让这一条先写出去，下一条另成一包
    await (intervalMs > 0 ? pause(intervalMs) : tick())
    // 回合被打断时对面会断开这个请求，后面的不用发了
    if (res.destroyed) return
  }
  const emitMs = Number(process.hrtime.bigint() - started) / 1e6
  chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: deltas, total_tokens: 10 } })
  res.end('data: [DONE]\n\n')
  parentPort.postMessage({ type: 'emitted', stream, deltas, emitMs })
})

parentPort.on('message', (message) => {
  if (message.type === 'plan') {
    plan = { deltas: message.deltas, intervalMs: message.intervalMs }
    parentPort.postMessage({ type: 'planned' })
  } else if (message.type === 'close') {
    server.closeAllConnections()
    server.close(() => process.exit(0))
  }
})

server.listen(0, '127.0.0.1', () =>
  parentPort.postMessage({ type: 'listening', port: server.address().port }),
)
