// 隔离环境里的“操作应用”：让假模型用桌面端的 Computer Use（客户端工具 litch_computer）看一个应用、往里打一段字、
// 再看一遍，然后把这几次工具结果原样说出来。真实窗口验收用它在授权过的 Mac 上验整条链路（审批卡片、屏幕提示、
// 停止、截图缩略图），模型是回环上的假模型，不花真模型的钱。
//
// 用户的话里带“操作应用”时：应用名取“应用：”后面那一段（没写就是 TextEdit），要打的字取“打字：”后面那一段
// （没写就不打）。get_app_state → type_text（有字才打）→ get_app_state → 回话“操作结果：”加上这几次的结果。
// 工具不在（会话不是 Litch 建的、这台桌面不是 macOS）时照实说一句。
//
// 话里带“脚本：”加一段 JSON 数组（[{"tool":"list_apps","args":{}}, …]）时，照顺序逐个调 litch_computer 的这些工具，
// 不管中间失败与否，全部调完后回话“操作结果：”加上每次的结果。Windows 上的真机验收用它点名要验的工具。
import { isUserTurn, piToolName } from './client-fixture-echo.mjs'

export const COMPUTER_TRIGGER = /操作应用|use the app/i
export const COMPUTER_HEARD = '操作结果：'
export const COMPUTER_MISSING = '没有 litch_computer 这个工具'
const SCRIPT_TRIGGER = /脚本：\s*(\[[\s\S]*\])/

const NAMES = {
  state: piToolName('litch_computer', 'get_app_state'),
  type: piToolName('litch_computer', 'type_text'),
}
const nameOf = (tool) => tool?.function?.name ?? tool?.name
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('')

/** 这次请求要不要走“操作应用”这条路。要的话返回假模型该给的回复，不要就是 null */
export function computerReply(body, lastUserText) {
  const script = lastUserText.match(SCRIPT_TRIGGER)
  if (script) return scriptReply(body, JSON.parse(script[1]))
  if (!COMPUTER_TRIGGER.test(lastUserText)) return null
  const messages = body.messages ?? []
  const userAt = messages.findLastIndex(isUserTurn)
  const since = messages.slice(userAt + 1)
  const calls = since.flatMap((message) => message.tool_calls ?? [])
  const mine = calls.filter((call) => Object.values(NAMES).includes(nameOf(call)))
  const app = lastUserText.match(/应用：(\S+)/)?.[1] ?? 'TextEdit'
  const words = lastUserText.match(/打字：(\S+)/)?.[1]
  if (mine.length === 0) {
    if (!(body.tools ?? []).some((tool) => nameOf(tool) === NAMES.state)) {
      return { text: COMPUTER_MISSING, pace: 50 }
    }
    return { tools: [{ name: NAMES.state, args: { app } }] }
  }
  const results = since
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message.content))
  // 头一次看就失败了（没授权、被拒、没开）：不再往下，照实说
  if (mine.length === 1 && /\[litch:/.test(results.at(-1) ?? '')) {
    return { text: `${COMPUTER_HEARD}\n${results.join('\n---\n')}`, pace: 20 }
  }
  if (mine.length === 1 && words) {
    return { tools: [{ name: NAMES.type, args: { app, text: words } }] }
  }
  if (nameOf(mine.at(-1)) === NAMES.type) {
    return { tools: [{ name: NAMES.state, args: { app } }] }
  }
  return { text: `${COMPUTER_HEARD}\n${results.join('\n---\n')}`, pace: 20 }
}

/** “脚本：”那一路：已经调了几个就接着调下一个，调完了把结果全说出来 */
function scriptReply(body, steps) {
  const messages = body.messages ?? []
  const since = messages.slice(messages.findLastIndex(isUserTurn) + 1)
  const done = since.flatMap((message) => message.tool_calls ?? []).length
  const next = steps[done]
  if (next) {
    const name = piToolName('litch_computer', next.tool)
    if (!(body.tools ?? []).some((tool) => nameOf(tool) === name)) {
      return { text: `${COMPUTER_MISSING}（${next.tool}）`, pace: 50 }
    }
    return { tools: [{ name, args: next.args ?? {} }] }
  }
  const results = since
    .filter((message) => message.role === 'tool')
    .map((message, at) => `[${steps[at]?.tool}] ${textOf(message.content)}`)
  return { text: `${COMPUTER_HEARD}\n${results.join('\n---\n')}`, pace: 20 }
}
