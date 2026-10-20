// 隔离环境里的“会话树”：让假模型照用户的原话调用 litch_sessions（列出、读取、派子会话、发消息、等、打断），
// 真实窗口验收用它走一遍派子会话、回报、唤醒、提案，模型是回环上的假模型，不花真模型的钱。
//
// 用户的话（一回合一次调用，工具结果回来后把结果原样说出来）：
//   会话：<工具> <JSON 参数>   要在行首（子会话的派出说明会引用父会话的标题，别再触发一次），调 litch_sessions.<工具>，比如 会话：start {"title":"查日志","prompt":"<够宽的简报>","initiation":"user_asked"}（fresh 的简报显示宽度不到 80 会被设备进程拒绝，汉字算 2：中文至少 40 字）
//   任务：<工具> <JSON 参数>   同样的做法调 litch_tasks.<工具>（定时任务，设备执行），比如 任务：create {"name":"日报","prompt":"总结","schedule":{"type":"interval","minutes":5}}
//   浏览器：<工具> <JSON 参数> 同样的做法调 litch_browser.<工具>（只认 navigate、snapshot），比如 浏览器：navigate {"url":"about:blank"}，
//                              用来在 dsh、OpenCode 上验桌面端执行的客户端工具（client-fixture-browse.mjs 只认 Pi 的工具名）
//   收尾：<JSON>               要在行首，调 litch_sessions.wrap_up：JSON 是 {"suggestions":[…]}，或者直接写那个数组，比如
//                              收尾：[{"title":"补测试","prompt":"<够宽的简报>"}]；结果回来后回一句“收尾结果：”加结果原文
// 设备进程注入的唤醒（<litch-session-event kind="wake">）：回一句“收到子会话的结果：<几条>”，不调工具。
// 设备进程注入的提醒收尾（<litch-session-event kind="remind">）：调一次 wrap_up（空列表），结果回来后回一句“已收尾”。
// 平时的回合不调 wrap_up（夹具的设备设置里提醒收尾缺省关，见 client-fixture-engines.mjs 的 fixtureDeviceSettings）。
// 工具不在（会话不是 Litch 建的、这家没有客户端工具、设置里关了会话编排）时照实说一句。
//
// 各家给模型的工具名不一样（Claude Code 是哈希过的 MCP 名，dsh 是 <命名空间>__<工具>，OpenCode 是挂上去的 MCP 名，
// Pi 是拼起来的名字，原生 codex 是命名空间），所以不按名字认，按工具说明的开头认：说明是 client-tools-sessions.mts、client-tools-tasks.mts
// 里写死的，各家都原样交给模型（Claude、Pi、dsh 会把命名空间的说明接在第一个工具前面，所以用“包含”）。
// 改了那边的说明要跟着改这里的 MARKS。

export const SESSIONS_TRIGGER = /^(会话|任务|浏览器)：(\w+)\s*(\{[\s\S]*\})?/m
export const SESSIONS_HEARD = '会话结果：'
export const SESSIONS_WOKEN = '收到子会话的结果：'
export const WRAP_UP_TRIGGER = /^收尾：\s*([[{][\s\S]*)$/m
export const WRAP_UP_HEARD = '收尾结果：'
export const REMIND_DONE = '已收尾'
const WAKE = /<litch-session-event kind="wake">([\s\S]*?)<\/litch-session-event>/
const REMIND = /<litch-session-event kind="remind">/

const SPACES = {
  会话: {
    namespace: 'litch_sessions',
    marks: {
      list: 'List sessions on this device',
      read: 'Read a session’s status and its last few turns',
      start: 'Start a sub-session, or propose one.',
      send: 'Send a message to one of your sub-sessions',
      wait: 'Wait until the given sessions stop',
      interrupt: 'Interrupt the running turn of one of your sub-sessions',
      accept: 'Start one of your proposal cards because the user told you to',
      withdraw: 'Withdraw a proposal card of yours',
      wrap_up: 'Call this exactly once at the end of every turn',
    },
  },
  任务: {
    namespace: 'litch_tasks',
    marks: {
      list: 'List the scheduled tasks on this device',
      create: 'Create a scheduled task.',
      update: 'Change a task. Only the given fields change.',
      delete: 'Delete a task and its run history.',
      run_now: 'Run a task once now, without changing its schedule.',
    },
  },
  浏览器: {
    namespace: 'litch_browser',
    marks: {
      navigate: 'Load a URL in a tab',
      snapshot: 'Read the page as an accessibility tree',
    },
  },
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')

/** 在工具表里按说明找 <命名空间>.<tool>：tools 是 [{ name, description }]，找不到是 null */
function findByMark(tools, space, tool) {
  const mark = space.marks[tool]
  return (
    tools.find((one) => typeof one.description === 'string' && one.description.includes(mark))
      ?.name ?? null
  )
}

/**
 * 这次请求要不要走“会话树”这条路。said 是用户最后说的话；nameOf(命名空间, 工具) 给这种说法里的工具名，没有是 null；
 * results 是这句话之后已经回来的工具结果。返回 null（不归这里管）、{ text }、或者 { call: { name, args } }
 */
export function sessionsStep(said, { nameOf, results }) {
  const wake = said.match(WAKE)
  if (wake) {
    const lines = wake[1].split('\n').filter((line) => line.startsWith('- '))
    return { text: `${SESSIONS_WOKEN}${lines.length} 条\n${lines.join('\n')}` }
  }
  // 提醒收尾、用户点名的收尾：都是调 litch_sessions.wrap_up
  const reminded = REMIND.test(said)
  const wrap = reminded ? null : said.match(WRAP_UP_TRIGGER)
  if (reminded || wrap) {
    if (results.length > 0)
      return { text: reminded ? REMIND_DONE : `${WRAP_UP_HEARD}\n${results.join('\n---\n')}` }
    const name = nameOf(SPACES.会话, 'wrap_up')
    if (!name) return { text: '没有 litch_sessions 这个工具' }
    let args = { suggestions: [] }
    if (wrap)
      try {
        const given = JSON.parse(wrap[1])
        args = Array.isArray(given) ? { suggestions: given } : given
      } catch {
        return { text: `参数不是 JSON：${wrap[1]}` }
      }
    return { call: { namespace: 'litch_sessions', name, args } }
  }
  const tool = said.match(SESSIONS_TRIGGER)
  if (!tool) return null
  if (results.length > 0) return { text: `${SESSIONS_HEARD}\n${results.join('\n---\n')}` }
  const space = SPACES[tool[1]]
  if (!Object.hasOwn(space.marks, tool[2]))
    return { text: `${space.namespace} 里没有 ${tool[2]} 这个工具` }
  const name = nameOf(space, tool[2])
  if (!name) return { text: `没有 ${space.namespace} 这个工具` }
  try {
    return { call: { namespace: space.namespace, name, args: tool[3] ? JSON.parse(tool[3]) : {} } }
  } catch {
    return { text: `参数不是 JSON：${tool[3]}` }
  }
}

// ---------- OpenAI chat：Pi、OpenCode ----------
const isUserTurn = (message) => message?.role === 'user'
const chatTools = (body) =>
  (body.tools ?? []).map((tool) => ({
    name: tool?.function?.name ?? tool?.name,
    description: tool?.function?.description ?? tool?.description ?? '',
  }))

/** OpenAI chat 形态（Pi、OpenCode）的回复：{ text, pace } 或 { tools: [{ name, args }] }，不归这里管是 null */
export function sessionsReply(body, said) {
  const tools = chatTools(body)
  if (tools.length === 0) return null
  const messages = body.messages ?? []
  const since = messages.slice(messages.findLastIndex(isUserTurn) + 1)
  const step = sessionsStep(said, {
    nameOf: (space, tool) => findByMark(tools, space, tool),
    results: since.some((m) => m.tool_calls?.length)
      ? since.filter((m) => m.role === 'tool').map((m) => textOf(m.content))
      : [],
  })
  if (!step) return null
  return step.call
    ? { tools: [{ name: step.call.name, args: step.call.args }] }
    : { text: step.text, pace: 20 }
}

// ---------- Anthropic Messages：Claude Code、dsh ----------
const blocksOf = (message) =>
  typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : (message?.content ?? [])
const isToolResult = (message) => blocksOf(message).some((block) => block.type === 'tool_result')

/** Anthropic 形态（Claude Code、dsh）的回复：一串内容块（anthropicReply 那种），不归这里管是 null */
export function sessionsAnthropic(body, said) {
  const tools = (body.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
  }))
  const messages = (body.messages ?? []).filter((message) => message.role !== 'system')
  const asked = messages.findLastIndex((m) => m.role === 'user' && !isToolResult(m))
  const results = messages
    .slice(asked + 1)
    .flatMap(blocksOf)
    .filter((block) => block.type === 'tool_result')
    .map((block) => textOf(block.content))
  const step = sessionsStep(said, {
    nameOf: (space, tool) => findByMark(tools, space, tool),
    results,
  })
  if (!step) return null
  return step.call
    ? [{ tool: step.call.name, input: step.call.args }]
    : [{ text: step.text, pace: 20 }]
}

// ---------- Responses：原生 codex ----------
/** Responses 形态（原生 codex）的回复：{ text, pieces, pace } 或 { call }，不归这里管是 null */
export function sessionsResponses(body, said) {
  const tools = body.tools ?? []
  const input = Array.isArray(body.input) ? body.input : []
  const results = input
    .slice(input.findLastIndex((item) => item?.role === 'user') + 1)
    .filter((item) => item?.type === 'function_call_output')
    .map((item) => (typeof item.output === 'string' ? item.output : textOf(item.output)))
  const step = sessionsStep(said, {
    nameOf: (space, tool) =>
      tools
        .find((entry) => entry?.type === 'namespace' && entry.name === space.namespace)
        ?.tools?.some((entry) => entry.name === tool)
        ? tool
        : null,
    results,
  })
  if (!step) return null
  if (!step.call) return { text: step.text, pieces: 3, pace: 20 }
  return {
    call: {
      namespace: step.call.namespace,
      name: step.call.name,
      arguments: JSON.stringify(step.call.args),
    },
  }
}
