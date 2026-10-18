// 隔离环境里的“操作本机”：让假的远程机器上的假模型照用户的原话调用 litch_machine（远程会话操作桌面端那台电脑），
// 或者用 harness 自己的命令工具跑一条 litch-machine 命令。真实窗口验收用它走一遍开关、卡片、访问范围、进程和复制，
// 模型是回环上的假模型，不花真模型的钱。
//
// 用户的话（一回合一次调用，工具结果回来后把结果原样说出来）：
//   本机：<工具> <JSON 参数>   调 litch_machine.<工具>，比如 本机：exec {"command":"uname -a"}；参数缺省是 {}
//   命令行：<一行命令>         用 harness 自己的命令工具跑这行命令（拿来跑 litch-machine，会话号由环境变量带过去）
//   你在哪                     不调工具，把工具说明里写的“你在哪台、控制端是哪台”那一句原样说出来
// 工具不在（会话不是 Litch 建的，或者这家没有动态工具）时照实说一句。
//
// 认词和怎么答只有一份（machineStep），四种说法各有一个接头：
//   machineReply       OpenAI chat（Pi、OpenCode），动态工具名见 piToolName，命令工具 bash
//   machineAnthropic   Anthropic Messages（Claude Code、dsh），Claude Code 的动态工具是 MCP 工具，命令工具 Bash / bash
//   machineResponses   Responses（原生 codex），动态工具是命名空间，命令工具 exec_command 之类
import { createHash } from 'node:crypto'
import { isUserTurn, piToolName } from './client-fixture-echo.mjs'

export const MACHINE_TRIGGER = /本机：(\w+)\s*(\{[\s\S]*\})?/
export const MACHINE_CLI_TRIGGER = /命令行：(.+)/
export const MACHINE_WHERE_TRIGGER = /你在哪/
export const MACHINE_HEARD = '本机结果：'
export const MACHINE_MISSING = '没有 litch_machine 这个工具'

const NAMESPACE = 'litch_machine'
const TOOLS = ['machines', 'exec', 'process', 'read_file', 'write_file', 'list_dir', 'copy']
const WHERE = /You are running on [^\n]*/

/**
 * 这次请求要不要走“操作本机”这条路。said 是用户最后说的话；
 * nameOf(工具) 给这种说法里 litch_machine.<工具> 的名字，工具表里没有就是 null；
 * seen 是模型看得到的全部说明（工具和系统提示）；results 是这句话之后已经回来的工具结果（有就说明这回合调过了）；
 * shell(命令) 给一次命令工具的调用 { name, args }，这家没有就是 null。
 * 返回 null（不归这里管）、{ text }、或者 { call: { name, args }, shell? }（shell 是命令工具的那一次）
 */
export function machineStep(said, { nameOf, seen, results, shell }) {
  const tool = said.match(MACHINE_TRIGGER)
  const cli = tool ? null : said.match(MACHINE_CLI_TRIGGER)
  if (!tool && !cli) {
    if (!MACHINE_WHERE_TRIGGER.test(said)) return null
    const where = seen.match(WHERE)?.[0]
    return { text: where ? `我知道的：${where}` : '工具说明里没有写我在哪台设备、控制端是哪台' }
  }
  if (results.length > 0) return { text: `${MACHINE_HEARD}\n${results.join('\n---\n')}` }
  if (cli) {
    const call = shell(cli[1].trim())
    return call ? { call, shell: true } : { text: '这里没有能跑命令的工具' }
  }
  if (!TOOLS.includes(tool[1])) return { text: `litch_machine 里没有 ${tool[1]} 这个工具` }
  const name = nameOf(tool[1])
  if (!name) return { text: MACHINE_MISSING }
  let args = {}
  try {
    args = tool[2] ? JSON.parse(tool[2]) : {}
  } catch {
    return { text: `参数不是 JSON：${tool[2]}` }
  }
  return { call: { name, args } }
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')

// ---------- OpenAI chat：Pi、OpenCode ----------
const PI_NAMES = new Map(TOOLS.map((tool) => [tool, piToolName(NAMESPACE, tool)]))
const chatName = (tool) => tool?.function?.name ?? tool?.name
const chatDescription = (tool) => tool?.function?.description ?? tool?.description ?? ''

/** OpenAI chat 形态（Pi、OpenCode）的回复：{ text, pace } 或 { tools: [{ name, args }] }，不归这里管是 null */
export function machineReply(body, lastUserText) {
  const offered = new Set((body.tools ?? []).map(chatName))
  // 不带工具的是引擎在起标题（OpenCode 会这样），不归这里管
  if (offered.size === 0) return null
  const messages = body.messages ?? []
  const since = messages.slice(messages.findLastIndex(isUserTurn) + 1)
  const step = machineStep(lastUserText, {
    nameOf: (tool) => (offered.has(PI_NAMES.get(tool)) ? PI_NAMES.get(tool) : null),
    seen: [
      ...(body.tools ?? []).map(chatDescription),
      ...messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)),
    ].join('\n'),
    results: since.some((m) => m.tool_calls?.length)
      ? since.filter((m) => m.role === 'tool').map((m) => textOf(m.content))
      : [],
    shell: (command) =>
      offered.has('bash')
        ? { name: 'bash', args: { command, description: 'litch-machine' } }
        : null,
  })
  if (!step) return null
  return step.call ? { tools: [step.call] } : { text: step.text, pace: 20 }
}

// ---------- Anthropic Messages：Claude Code、dsh ----------
/** Claude Code 里动态工具的名字（packages/claude/src/dynamic-tools.mts 的 dynamicToolName，经 MCP 服务 codex_harness_adapter） */
const claudeName = (tool) =>
  `mcp__codex_harness_adapter__t_${createHash('sha256')
    .update(JSON.stringify([NAMESPACE, tool]))
    .digest('hex')
    .slice(0, 40)}`
const SHELLS = { 'claude-code': 'Bash', dsh: 'bash' }
const blocksOf = (message) =>
  typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : (message?.content ?? [])
const isToolResult = (message) => blocksOf(message).some((block) => block.type === 'tool_result')

/**
 * Anthropic 形态（Claude Code、dsh）的回复：一串内容块（client-fixture-anthropic.mjs 的 anthropicReply 那种），
 * 不归这里管是 null。said 是那边认出来的用户的话（去掉了引擎夹进来的提示）
 */
export function machineAnthropic(harness, body, said) {
  const offered = new Set((body.tools ?? []).map((tool) => tool.name))
  const messages = (body.messages ?? []).filter((message) => message.role !== 'system')
  const asked = messages.findLastIndex((m) => m.role === 'user' && !isToolResult(m))
  const results = messages
    .slice(asked + 1)
    .flatMap(blocksOf)
    .filter((block) => block.type === 'tool_result')
    .map((block) => textOf(block.content))
  const system = typeof body.system === 'string' ? body.system : textOf(body.system)
  const step = machineStep(said, {
    nameOf: (tool) =>
      harness === 'claude-code' && offered.has(claudeName(tool)) ? claudeName(tool) : null,
    seen: [...(body.tools ?? []).map((tool) => tool.description ?? ''), system].join('\n'),
    results,
    shell: (command) =>
      offered.has(SHELLS[harness])
        ? { name: SHELLS[harness], args: { command, description: 'litch-machine' } }
        : null,
  })
  if (!step) return null
  return step.call
    ? [{ tool: step.call.name, input: step.call.args }]
    : [{ text: step.text, pace: 20 }]
}

// ---------- Responses：原生 codex ----------
/** codex 的命令工具：哪个在工具表里就用哪个，参数的写法各不一样 */
const CODEX_SHELLS = [
  ['exec_command', (command) => ({ cmd: command })],
  ['shell_command', (command) => ({ command })],
  ['shell', (command) => ({ command: ['bash', '-lc', command] })],
]

/**
 * Responses 形态（原生 codex）的回复：{ text, pieces, pace } 或 { call: { name, namespace?, arguments } }
 * （client-fixture-responses.mjs 的 sendResponse 那种），不归这里管是 null
 */
export function machineResponses(body, said) {
  const tools = body.tools ?? []
  const space = tools.find((entry) => entry?.type === 'namespace' && entry.name === NAMESPACE)
  const input = Array.isArray(body.input) ? body.input : []
  const results = input
    .slice(input.findLastIndex((item) => item?.role === 'user') + 1)
    .filter((item) => item?.type === 'function_call_output')
    .map((item) => (typeof item.output === 'string' ? item.output : textOf(item.output)))
  const functions = new Set(tools.map((entry) => entry?.name))
  const step = machineStep(said, {
    nameOf: (tool) => (space?.tools?.some((entry) => entry.name === tool) ? tool : null),
    seen: [
      ...tools.flatMap((entry) => [
        entry?.description ?? '',
        ...(entry?.tools ?? []).map((one) => one.description ?? ''),
      ]),
      typeof body.instructions === 'string' ? body.instructions : '',
    ].join('\n'),
    results,
    shell: (command) => {
      const found = CODEX_SHELLS.find(([name]) => functions.has(name))
      return found ? { name: found[0], args: found[1](command) } : null
    },
  })
  if (!step) return null
  if (!step.call) return { text: step.text, pieces: 3, pace: 20 }
  return {
    call: {
      ...(step.shell ? {} : { namespace: NAMESPACE }),
      name: step.call.name,
      arguments: JSON.stringify(step.call.args),
    },
  }
}
