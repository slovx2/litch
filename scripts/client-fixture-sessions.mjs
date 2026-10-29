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
//   新任务：<标题>             要在行首，调 litch_sessions.start（initiation offer，只带标题），等用户在卡上选：选了新会话就调 accept
//                              带一段够宽的简报，结果回来后回一句“已开新会话：”加结果原文；选了在这里做（或者没选就又发了话、
//                              回合结束了）回一句“在这里做：<标题>”
//   交接：<标题>               要在行首，调 litch_sessions.hand_off（剩下的计划是一段写死的话），结果回来后回一句“已交接：”加结果原文
// 设备进程注入的唤醒（<litch-session-event kind="wake">）：回一句“收到子会话的结果：<几条>”，不调工具。
// 回合进行中设备进程插进来的回报（只有 <litch-session-event kind="notes">、后面没有用户的话）：回一句“收到子会话的回报：<几条>”，不调工具。
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
export const SESSIONS_NOTED = '收到子会话的回报：'
export const WRAP_UP_TRIGGER = /^收尾：\s*([[{][\s\S]*)$/m
export const WRAP_UP_HEARD = '收尾结果：'
export const REMIND_DONE = '已收尾'
export const OFFER_TRIGGER = /^新任务：\s*(.+)$/m
export const OFFER_STARTED = '已开新会话：'
export const OFFER_HERE = '在这里做：'
export const HAND_OFF_TRIGGER = /^交接：\s*(.+)$/m
export const HAND_OFF_HEARD = '已交接：'
const WAKE = /<litch-session-event kind="wake">([\s\S]*?)<\/litch-session-event>/
const NOTES_ONLY = /^<litch-session-event kind="notes">([\s\S]*?)<\/litch-session-event>\s*$/
const REMIND = /<litch-session-event kind="remind">/

const SPACES = {
  会话: {
    namespace: 'litch_sessions',
    marks: {
      list: 'List sessions on this device',
      read: 'Read a session’s status',
      respond: 'Explicitly answer a pending question or approval.',
      start: 'Start a sub-session, propose one, or offer a new session.',
      send: 'Send a message to a session: one of your sub-sessions',
      wait: 'Wait until the given sessions stop',
      interrupt: 'Interrupt the running turn of one of your sub-sessions, or of any session',
      accept: 'Start one of your cards:',
      withdraw: 'Withdraw a proposal card of yours',
      wrap_up: 'Call this exactly once in every turn',
      hand_off: 'Move the task you are in the middle of into its own session',
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
  const noted = said.match(NOTES_ONLY)
  if (noted) {
    const lines = noted[1].split('\n').filter((line) => line.startsWith('- '))
    return { text: `${SESSIONS_NOTED}${lines.length} 条\n${lines.join('\n')}` }
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
  const offered = said.match(OFFER_TRIGGER)
  if (offered) return offerStep(offered[1].trim(), { nameOf, results })
  const handed = said.match(HAND_OFF_TRIGGER)
  if (handed) {
    if (results.length > 0) return { text: `${HAND_OFF_HEARD}\n${results[0]}` }
    const name = nameOf(SPACES.会话, 'hand_off')
    if (!name) return { text: '没有 litch_sessions 这个工具' }
    const title = handed[1].trim()
    return {
      call: {
        namespace: 'litch_sessions',
        name,
        args: { title, remaining_plan: `${title}：还剩把改动补完、跑一遍检查，${HAND_OFF_PLAN}` },
      },
    }
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

/** 交接时剩下的计划、选了新会话时补的简报共用的后半段：够设备进程的简报宽度门槛（汉字算 2，至少 80） */
const HAND_OFF_PLAN =
  '相关文件都在这个项目里，先读一遍 README 和目录结构再动手；做完的标准是改动能通过已有的检查，结束时用两三句话说明改了什么、怎么验证的、还剩什么没做。'

/** 选了新会话时补的背景：新开的会话看不到这边的对话，设备进程要求 fresh 的简报带够宽的背景（同上，至少 80） */
const OFFER_BACKGROUND =
  '这是隔离环境里的验收项目，用户在原来的会话里提了一件和那边的工作无关的新任务，在卡上选了开新会话；原来的会话没做过和它相关的决定，也没有别的约束。'

/** 新任务：先出 offer 卡等用户选；选了新会话再 accept 补简报和背景 */
function offerStep(title, { nameOf, results }) {
  if (results.length === 0) {
    const name = nameOf(SPACES.会话, 'start')
    if (!name) return { text: '没有 litch_sessions 这个工具' }
    return { call: { namespace: 'litch_sessions', name, args: { title, initiation: 'offer' } } }
  }
  if (results.length > 1) return { text: `${OFFER_STARTED}\n${results[1]}` }
  let answered = null
  try {
    answered = JSON.parse(results[0])
  } catch {
    // 失败的结果是 [litch:<kind>] 开头的一句话，不是 JSON
  }
  if (answered?.choice !== 'session') return { text: `${OFFER_HERE}${title}\n${results[0]}` }
  const name = nameOf(SPACES.会话, 'accept')
  if (!name) return { text: '没有 litch_sessions.accept 这个工具' }
  return {
    call: {
      namespace: 'litch_sessions',
      name,
      args: {
        proposal_id: answered.proposal_id,
        prompt: `新会话的任务是${title}。${HAND_OFF_PLAN}`,
        background: OFFER_BACKGROUND,
      },
    },
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
