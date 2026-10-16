// 量增量开销用的假模型（scripts/bench-delta.mjs 把它起在单独的线程里）。
// 说的是 OpenAI 的流式对话接口，只在回环上听。每个请求按约定的条数吐增量，每条的字数一样多；
// 增量可以是正文、思考，或者一次 write 工具调用的参数（模型写一个很长的文件时就是这种）。
// 吐完把全文的长度和摘要报给主线程，量的那一头拿它核对收到的和落库的字。
// 另有一种不是增量的（calls）：一个回合里连着调很多次工具，每次读同一个大文件，量的是条目的增减，
// 这时“条数”是调用的次数，文件由量的那一头备好，假模型只管发调用、数调用。
// 放在单独的线程里，是为了吐字的节奏不被收消息的那一头拖慢。
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { parentPort } from 'node:worker_threads'

/** 接下来的请求：吐多少条、每条多少个字、是哪一种（text、thinking、tool）、条与条隔多久（毫秒，0 是不等） */
let plan = { deltas: 1, chars: 4, kind: 'text', intervalMs: 0 }
let streams = 0
/** calls 那种让模型反复读的文件（相对工作目录），和 bench-delta.mjs 里备的那份是同一个名字 */
const CALLS_FILE = 'bench-read.txt'
/** calls 那种回合里头一次请求到的时刻：“吐完用了多久”从它算到最后一次请求 */
let callsStarted = 0n

// 增量的字从这一段里循环着取：中文、英文、标点、换行都有；一共 59 个字，和常用的每条字数互质，各条不会一样
const SOURCE = [
  ...'流式输出的每一小段都变成一条增量通知。\nconst sum = (a, b) => a + b; // 很长的回答。\n',
]
const piece = (seq, chars) => {
  let text = ''
  for (let index = 0; index < chars; index++) text += SOURCE[(seq * chars + index) % SOURCE.length]
  return text
}

const tick = () => new Promise((done) => setImmediate(done))
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const stream = ++streams
  const { deltas, chars, kind, intervalMs } = plan
  // 每个请求用完就关连接，原因见 bench-router-model.mjs
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  // 每条增量各自成包发走，不让系统把相邻的几条攒在一起
  res.socket?.setNoDelay(true)
  const base = { id: `bench_${stream}`, object: 'chat.completion.chunk', created: 1 }
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    )
  const usage = { usage: { prompt_tokens: 10, completion_tokens: deltas, total_tokens: 10 } }
  if (kind === 'calls') {
    // 请求里带着到现在为止的全部工具结果：还没调够就再调一次 read，调够了回一句话收场
    const done = (body.messages ?? []).filter((message) => message.role === 'tool').length
    if (done === 0) callsStarted = process.hrtime.bigint()
    if (done < deltas) {
      const call = { index: 0, id: `call_${stream}`, type: 'function' }
      const read = { name: 'read', arguments: JSON.stringify({ path: CALLS_FILE }) }
      chunk({ role: 'assistant', content: null, tool_calls: [{ ...call, function: read }] })
      chunk({}, 'tool_calls', usage)
      res.end('data: [DONE]\n\n')
      return
    }
    chunk({ role: 'assistant', content: 'ok' })
    chunk({}, 'stop', usage)
    res.end('data: [DONE]\n\n')
    const emitMs = Number(process.hrtime.bigint() - callsStarted) / 1e6
    parentPort.postMessage({ type: 'emitted', stream, calls: done, emitMs })
    return
  }
  // 工具跑完之后运行时会带着结果再来问一次：回一句短话收场，这一次不算在量的里面
  if (body.messages?.at(-1)?.role === 'tool') {
    chunk({ role: 'assistant', content: '' })
    chunk({ content: 'ok' })
    chunk({}, 'stop', usage)
    res.end('data: [DONE]\n\n')
    return
  }
  /** 工具调用的参数是一段 JSON，字要先转义再放进去 */
  const argument = (text) => ({ tool_calls: [{ index: 0, function: { arguments: text } }] })
  if (kind === 'tool') {
    const call = { index: 0, id: `call_${stream}`, type: 'function' }
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [{ ...call, function: { name: 'write', arguments: '' } }],
    })
    chunk(argument(`{"path":"bench-${stream}.txt","content":"`))
  } else chunk({ role: 'assistant', content: '' })
  const hash = createHash('sha256')
  let length = 0
  const started = process.hrtime.bigint()
  for (let seq = 0; seq < deltas; seq++) {
    const text = piece(seq, chars)
    hash.update(text)
    length += text.length
    if (kind === 'tool') chunk(argument(JSON.stringify(text).slice(1, -1)))
    else chunk(kind === 'thinking' ? { reasoning_content: text } : { content: text })
    // 不等的时候也让出一次：让这一条先写出去，下一条另成一包
    await (intervalMs > 0 ? pause(intervalMs) : tick())
    // 回合被打断时对面会断开这个请求，后面的不用发了
    if (res.destroyed) return
  }
  const emitMs = Number(process.hrtime.bigint() - started) / 1e6
  if (kind === 'tool') chunk(argument('"}'))
  // 只有思考没有正文的回答不像真的：思考完补一句
  if (kind === 'thinking') chunk({ content: 'ok' })
  chunk({}, kind === 'tool' ? 'tool_calls' : 'stop', usage)
  res.end('data: [DONE]\n\n')
  parentPort.postMessage({ type: 'emitted', stream, length, sha256: hash.digest('hex'), emitMs })
})

parentPort.on('message', (message) => {
  if (message.type === 'plan') {
    plan = {
      deltas: message.deltas,
      chars: message.chars,
      kind: message.kind,
      intervalMs: message.intervalMs,
    }
    parentPort.postMessage({ type: 'planned' })
  } else if (message.type === 'close') {
    server.closeAllConnections()
    server.close(() => process.exit(0))
  }
})

server.listen(0, '127.0.0.1', () =>
  parentPort.postMessage({ type: 'listening', port: server.address().port }),
)
