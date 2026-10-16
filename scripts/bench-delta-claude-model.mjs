// 量 Claude 入口增量开销用的假模型（scripts/bench-delta-claude.mjs 把它起在单独的线程里）。
// 说的是 Anthropic 的流式消息接口（/v1/messages），只在回环上听。量的那个请求按约定的条数吐增量，
// 每条的字数一样多；增量可以是正文、思考，或者一次 Write 工具调用的参数（模型写一个很长的文件时就是这种）。
// 还有一种（tools）不吐增量，而是一个回合里接连调很多次工具：每次叫 CLI 用 Bash 把主线程备好的
// 同一个文件 cat 出来（结果有多大由那个文件定），CLI 带着结果再来问时接着调，调够了次数说一句收场。
// 开吐之前先告诉主线程并等它放行（它要在这一刻给两个进程的 CPU 读数打个底），
// 吐完把全文的长度和摘要报回去，量的那一头拿它核对收到的和落库的字。
// 和 bench-delta-model.mjs 是同一个路数，只是协议不同；增量的字也是同一段里循环着取的。
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { parentPort } from 'node:worker_threads'

/**
 * 接下来要量的请求：吐多少条、每条多少个字、是哪一种（text、thinking、tool、tools）、条与条隔多久、
 * 工具写到哪个文件（tools 时是每次 cat 的那个文件，条数就是调几次工具）
 */
let plan = { deltas: 1, chars: 4, kind: 'text', intervalMs: 0, path: '' }
let streams = 0
/** 主线程放行之前，量的那个请求等在这里 */
let release = null
/** tools：这一个回合里已经调了几次工具 */
let calls = 0
let callsStarted = 0n

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
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** 是不是要量的那个请求：主会话的流式请求，最后一条是用户说的话（不是工具的结果） */
function measured(body) {
  const last = body.messages?.at(-1)
  if (body.stream !== true || !body.tools?.length || last?.role !== 'user') return false
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]
  return !blocks.some((block) => block.type === 'tool_result')
}

/** tools：CLI 带着我们要它调的那次工具的结果又来问了 */
function continued(body) {
  const last = body.messages?.at(-1)
  if (body.stream !== true || !body.tools?.length || last?.role !== 'user') return false
  if (!Array.isArray(last.content)) return false
  return last.content.some(
    (block) => block.type === 'tool_result' && block.tool_use_id?.startsWith('toolu_bench_'),
  )
}

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const json = (value) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }
  if (req.url === '/api/hello') return json({})
  if (req.url?.startsWith('/v1/messages/count_tokens')) return json({ input_tokens: 100 })
  if (!req.url?.startsWith('/v1/messages')) return res.writeHead(404).end()
  const stream = ++streams
  const message = {
    id: `msg_bench_${stream}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  }
  const closing = [{ type: 'text', text: 'ok' }]
  // CLI 自己另发的不流式的小请求：回一句短话
  if (body.stream !== true) return json({ ...message, content: closing, stop_reason: 'end_turn' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  // 每条增量各自成包发走，不让系统把相邻的几条攒在一起
  res.socket?.setNoDelay(true)
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const block = (index, content, delta) => {
    event('content_block_start', { index, content_block: content })
    if (delta) event('content_block_delta', { index, delta })
  }
  const finish = (stop) => {
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage })
    event('message_stop', {})
    res.end()
  }
  event('message_start', { message })
  if (plan.kind === 'tools' && (measured(body) || continued(body))) {
    if (measured(body)) {
      calls = 0
      // 先等主线程放行，再调头一次工具
      const go = new Promise((done) => {
        release = done
      })
      parentPort.postMessage({ type: 'streaming', stream })
      await go
      callsStarted = process.hrtime.bigint()
    }
    if (calls < plan.deltas) {
      calls++
      const input = { command: `cat '${plan.path}'`, description: '读出备好的文件' }
      block(
        0,
        { type: 'tool_use', id: `toolu_bench_${stream}`, name: 'Bash', input: {} },
        { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      )
      event('content_block_stop', { index: 0 })
      return finish('tool_use')
    }
    block(0, { type: 'text', text: '' }, { type: 'text_delta', text: 'ok' })
    event('content_block_stop', { index: 0 })
    finish('end_turn')
    // 全文是主线程备的文件，它自己知道长度和摘要；这里只报调够了次数用了多久
    const emitMs = Number(process.hrtime.bigint() - callsStarted) / 1e6
    parentPort.postMessage({ type: 'emitted', stream, length: 0, sha256: '', emitMs })
    return
  }
  // 不是要量的那个（工具跑完之后带着结果再来问的那一次等）：回一句短话收场
  if (!measured(body)) {
    block(0, { type: 'text', text: '' }, { type: 'text_delta', text: 'ok' })
    event('content_block_stop', { index: 0 })
    return finish('end_turn')
  }
  const { deltas, chars, kind, intervalMs, path } = plan
  if (kind === 'tool')
    block(
      0,
      { type: 'tool_use', id: `toolu_bench_${stream}`, name: 'Write', input: {} },
      {
        type: 'input_json_delta',
        partial_json: `{"file_path":${JSON.stringify(path)},"content":"`,
      },
    )
  else
    block(0, kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' })
  // 开头这几帧先让对面收走，再等主线程放行：之后两个进程花的 CPU 才都算在增量头上
  const go = new Promise((done) => {
    release = done
  })
  parentPort.postMessage({ type: 'streaming', stream })
  await go
  const hash = createHash('sha256')
  let length = 0
  const started = process.hrtime.bigint()
  for (let seq = 0; seq < deltas; seq++) {
    const text = piece(seq, chars)
    hash.update(text)
    length += text.length
    const delta =
      kind === 'tool'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(text).slice(1, -1) }
        : kind === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text }
    event('content_block_delta', { index: 0, delta })
    // 不等的时候也让出一次：让这一条先写出去，下一条另成一包
    await (intervalMs > 0 ? pause(intervalMs) : tick())
    // 回合被打断时对面会断开这个请求，后面的不用发了
    if (res.destroyed) return
  }
  const emitMs = Number(process.hrtime.bigint() - started) / 1e6
  if (kind === 'tool') {
    // 文件末尾补一个句号再收口：全文恰好以空白结尾时，交到入口手里的参数已经少了那个空白，核对就对不上了
    hash.update('。')
    length += 1
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '。"}' },
    })
  }
  if (kind === 'thinking')
    event('content_block_delta', {
      index: 0,
      delta: { type: 'signature_delta', signature: 'bench-signature' },
    })
  event('content_block_stop', { index: 0 })
  // 只有思考没有正文的回答不像真的：思考完补一句
  if (kind === 'thinking') {
    block(1, { type: 'text', text: '' }, { type: 'text_delta', text: 'ok' })
    event('content_block_stop', { index: 1 })
  }
  finish(kind === 'tool' ? 'tool_use' : 'end_turn')
  parentPort.postMessage({ type: 'emitted', stream, length, sha256: hash.digest('hex'), emitMs })
})

parentPort.on('message', (message) => {
  if (message.type === 'plan') {
    plan = {
      deltas: message.deltas,
      chars: message.chars,
      kind: message.kind,
      intervalMs: message.intervalMs,
      path: message.path,
    }
    parentPort.postMessage({ type: 'planned' })
  } else if (message.type === 'go') {
    release?.()
    release = null
  }
})

server.listen(0, '127.0.0.1', () =>
  parentPort.postMessage({ type: 'listening', port: server.address().port }),
)
