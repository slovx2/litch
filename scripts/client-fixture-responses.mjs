// 原生 codex 那一路的隔离环境，夹具（device-fixture.mjs、client-local-fixture.mjs）和两条 codex 检查
// （check-native-codex.mjs、check-client-tools-codex.mjs）共用这一份：
//   - 用哪一份 codex（findCodex：CHA_CODEX_CLI，没给是 PATH 里的）；
//   - codex 的配置（codexConfig：模型只走回环上的假接口）；
//   - 假模型：codex 说的是 OpenAI Responses 接口（/v1/responses，流式事件）。sendResponse 发一次回复（一段文字，
//     或者一次函数调用），startResponsesModel 起一个回环上的假接口、每次请求问调用方回什么；
//     夹具用 serveResponses：把用户的话带回来，开头注明是哪个 harness 收到的（和 Pi 那一路的 piReply 同一个说法），
//     分几段慢慢发，界面上看得到字是一点一点出来的；
//   - 收尾（codexSocketCleanup）：codex 的套接字是个链接，真的文件建在 /tmp/codex-daemon-<uid>/ 下，它退出时链接没了、
//     旁边的锁还留着。
// 事件的形状对着真的 codex（0.160.0、0.163.0）实测过。
// 行首“经理：<操作> <JSON 参数>”经 sessionsResponses 调 litch_manager；经理开场、答复、结束事件固定回话，见 client-fixture-manager.mjs。

import { readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { backgroundResponses } from './client-fixture-background.mjs'
import { askResponses } from './client-fixture-codex-ask.mjs'
import { machineResponses } from './client-fixture-machine.mjs'
import { sessionsResponses } from './client-fixture-sessions.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const executable = (path) => {
  try {
    return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * 用哪一份 codex：给了 CHA_CODEX_CLI 就用它（流水线上是 npm 装的精确版本，给了却用不了就抛错，不悄悄换一份），
 * 没给是 PATH 里第一个可执行的 codex（官方桌面端自带的那一份不算）。都没有是 null
 */
export function findCodex(env = process.env) {
  const given = env.CHA_CODEX_CLI?.trim()
  if (given) {
    if (executable(given)) return given
    throw new Error(`CHA_CODEX_CLI 指的不是一个可执行的文件：${given}`)
  }
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, 'codex')
    if (executable(candidate) && !realpathSync(candidate).startsWith('/Applications/'))
      return candidate
  }
  return null
}

/**
 * codex 的配置：模型只走回环上的假接口，不重试，不上报。
 * 写在隔离的 CODEX_HOME 里，用户的 ~/.codex 碰不到
 */
export const codexConfig = (baseUrl) =>
  [
    'model = "fixture-gate"',
    'model_provider = "fixture"',
    '',
    '[model_providers.fixture]',
    'name = "Fixture"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n')

/**
 * codex 还在跑时认下它的套接字背后那两个文件（链接指向的套接字和旁边的锁），返回收完进程之后删它们的函数。
 * 没起 codex、或者这一版直接在给的路径上建套接字时，返回的函数什么都不做
 */
export function codexSocketCleanup(socket) {
  let files = []
  try {
    const physical = resolve(dirname(socket), readlinkSync(socket))
    files = [physical, `${physical}.lock`]
  } catch {
    // 不是链接，或者还没有
  }
  return () => {
    for (const path of files) rmSync(path, { force: true })
  }
}

/** 一条消息里的文字 */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')

/** 请求里用户说的最后一句话 */
export const userText = (body) =>
  textOf(
    (Array.isArray(body.input) ? body.input : []).findLast((item) => item?.role === 'user')
      ?.content,
  )

/** 请求里工具表上的命名空间 */
export const namespacesOf = (body) =>
  (body.tools ?? []).filter((entry) => entry?.type === 'namespace').map((entry) => entry.name)

/**
 * 按 Responses 的流式事件发一次回复。reply 是 { text, pieces?, pace?, delay? }（一段文字，分 pieces 段、每段停 pace 毫秒，
 * 给了 delay 先停这么久），
 * 或者 { call: { name, arguments, namespace? } }（一次函数调用）。serial 拿来编标识
 */
export async function sendResponse(res, reply, serial) {
  // delay：先停这么久再回（模型还在想，回合一直在跑）
  if (reply.delay) await pause(reply.delay)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const id = `resp_${serial}`
  emit({ type: 'response.created', response: { id } })
  if (reply.call) {
    emit({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: `call_${serial}`, ...reply.call },
    })
  } else {
    const text = reply.text
    const item = { type: 'message', role: 'assistant', id: `msg_${serial}`, phase: 'final_answer' }
    emit({ type: 'response.output_item.added', item: { ...item, content: [] } })
    const size = Math.max(1, Math.ceil(text.length / (reply.pieces ?? 1)))
    for (let at = 0; at < text.length; at += size) {
      emit({ type: 'response.output_text.delta', delta: text.slice(at, at + size) })
      if (reply.pace) await pause(reply.pace)
      // 回合被打断时对面会断开这个请求，后面的不用发了
      if (res.destroyed) return
    }
    emit({
      type: 'response.output_item.done',
      item: { ...item, content: [{ type: 'output_text', text }] },
    })
  }
  const usage = {
    input_tokens: 10,
    input_tokens_details: null,
    output_tokens: 5,
    output_tokens_details: null,
    total_tokens: 15,
  }
  emit({ type: 'response.completed', response: { id, usage } })
  res.end()
}

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":{"message":"not found"}}')
}

const parse = (raw) => {
  try {
    return JSON.parse(raw.toString() || '{}')
  } catch {
    // 不是 JSON：照空的处理
    return {}
  }
}

/**
 * 夹具里的那一种：把话带回来。path 是去掉 harness 前缀之后的路径，raw 是请求体。
 * 返回这次请求里工具表上的命名空间（不是 Responses 请求的返回 null）
 */
export async function serveResponses(harness, path, raw, res, { serial, pace = 120 }) {
  if (!path.endsWith('/responses')) {
    notFound(res)
    return null
  }
  const body = parse(raw)
  // 操作本机（litch_machine 和 litch-machine 命令）的那几句，见 client-fixture-machine.mjs
  // 会话树（litch_sessions 和设备注入的唤醒）的那几句，见 client-fixture-sessions.mjs
  // 边做边问（request_user_input_async）的那几句，见 client-fixture-codex-ask.mjs
  // 后台跑一条命令（看后台任务）的那一句，见 client-fixture-background.mjs
  const machine =
    sessionsResponses(body, userText(body)) ??
    machineResponses(body, userText(body)) ??
    askResponses(body, userText(body)) ??
    backgroundResponses(body, userText(body))
  if (machine) {
    await sendResponse(res, machine, serial)
    return namespacesOf(body)
  }
  const text = `${harness} 收到：${userText(body)}\n\n这是隔离设备里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`
  await sendResponse(res, { text, pieces: 6, pace }, serial)
  return namespacesOf(body)
}

/**
 * 在回环上起一个假的 Responses 接口（地址是 baseUrl，写进 codexConfig）。每次请求调 decide(body, serial)，
 * 它返回要发的回复（sendResponse 的 reply）。requests() 是到现在收到过几次请求
 */
export async function startResponsesModel(decide) {
  let count = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.method !== 'POST' || !(request.url ?? '').endsWith('/responses'))
      return notFound(response)
    const serial = ++count
    await sendResponse(response, decide(parse(Buffer.concat(chunks)), serial), serial)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests: () => count,
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}
