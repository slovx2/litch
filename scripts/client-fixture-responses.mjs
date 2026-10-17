// 原生 codex 那一路的假模型：codex 说的是 OpenAI Responses 接口（/v1/responses，流式事件）。
// 隔离环境里只认最朴素的一种：把用户的话带回来，开头注明是哪个 harness 收到的（和 Pi 那一路的 piReply 同一个说法），
// 分几段慢慢发，界面上看得到字是一点一点出来的。工具调用、提问这些词它不认：原生 codex 的这几样由真的引擎做，
// 夹具只验“从界面建会话、发一句、收到回话”这条主路径（apps/desktop/scripts/check-first-turn.mjs）。
// 每次请求里工具表上的命名空间记下来交给调用方：Litch 建会话时带的工具定义 codex 有没有原样交给模型，看这个。
// 做法照 scripts/check-client-tools-codex.mjs 里那一份，那边对着真的 codex 实测过事件的形状。

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')

/**
 * 回一次 Responses 请求。path 是去掉 harness 前缀之后的路径，raw 是请求体。
 * 返回这次请求里工具表上的命名空间（不是 Responses 请求的返回 null）
 */
export async function serveResponses(harness, path, raw, res, { serial, pace = 120 }) {
  if (!path.endsWith('/responses')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"not found"}}')
    return null
  }
  let body = {}
  try {
    body = JSON.parse(raw.toString() || '{}')
  } catch {
    // 不是 JSON：照空的处理
  }
  const input = Array.isArray(body.input) ? body.input : []
  const said = textOf(input.findLast((item) => item?.role === 'user')?.content)
  const namespaces = (body.tools ?? [])
    .filter((entry) => entry?.type === 'namespace')
    .map((entry) => entry.name)
  const text = `${harness} 收到：${said}\n\n这是隔离设备里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`

  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const id = `resp_${serial}`
  const item = { type: 'message', role: 'assistant', id: `msg_${serial}`, phase: 'final_answer' }
  emit({ type: 'response.created', response: { id } })
  emit({ type: 'response.output_item.added', item: { ...item, content: [] } })
  const size = Math.max(1, Math.ceil(text.length / 6))
  for (let at = 0; at < text.length; at += size) {
    emit({ type: 'response.output_text.delta', delta: text.slice(at, at + size) })
    await pause(pace)
    // 回合被打断时对面会断开这个请求，后面的不用发了
    if (res.destroyed) return namespaces
  }
  emit({
    type: 'response.output_item.done',
    item: { ...item, content: [{ type: 'output_text', text }] },
  })
  const usage = {
    input_tokens: 10,
    input_tokens_details: null,
    output_tokens: 5,
    output_tokens_details: null,
    total_tokens: 15,
  }
  emit({ type: 'response.completed', response: { id, usage } })
  res.end()
  return namespaces
}

/**
 * codex 的配置：模型只走回环上的假接口（地址里带着 harness 的标识），不重试，不上报。
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
