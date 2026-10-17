// 隔离环境里的“浏览”：让假模型用桌面端的内置浏览器（客户端工具 litch_browser）打开一个地址、等页面上出现
// 某段字、读一遍快照，再把这几次工具结果原样说出来。远程端到端（apps/desktop/scripts/check-tools-remote.mjs）
// 用它验“远端 localhost 经 ssh 转发到桌面的浏览器里打开”这整条链路。
//
// 用户的话里带“浏览”和一个网址时：navigate 到那个网址 → wait 页面上出现“等字：”后面那段字（没写就不等）
// → snapshot → 回话“浏览结果：”加上这几次的结果。工具不在（会话不是 Litch 建的）时照实说一句。
import { isUserTurn, piToolName } from './client-fixture-echo.mjs'

export const BROWSE_TRIGGER = /浏览|browse/i
export const BROWSE_HEARD = '浏览结果：'
export const BROWSE_MISSING = '没有 litch_browser 这个工具'

const NAMES = {
  navigate: piToolName('litch_browser', 'navigate'),
  wait: piToolName('litch_browser', 'wait'),
  snapshot: piToolName('litch_browser', 'snapshot'),
}
const nameOf = (tool) => tool?.function?.name ?? tool?.name
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('')

/** 这次请求要不要走浏览这条路。要的话返回假模型该给的回复，不要就是 null */
export function browseReply(body, lastUserText) {
  if (!BROWSE_TRIGGER.test(lastUserText)) return null
  const messages = body.messages ?? []
  const userAt = messages.findLastIndex(isUserTurn)
  const since = messages.slice(userAt + 1)
  const calls = since.flatMap((message) => message.tool_calls ?? [])
  const mine = calls.filter((call) => Object.values(NAMES).includes(nameOf(call)))
  if (mine.length === 0) {
    if (!(body.tools ?? []).some((tool) => nameOf(tool) === NAMES.navigate)) {
      return { text: BROWSE_MISSING, pace: 50 }
    }
    const url = lastUserText.match(/https?:\/\/\S+/)?.[0]
    if (!url) return null
    return { tools: [{ name: NAMES.navigate, args: { url } }] }
  }
  const last = nameOf(mine.at(-1))
  const waitFor = lastUserText.match(/等字：(\S+)/)?.[1]
  if (last === NAMES.navigate && waitFor) {
    return {
      tools: [{ name: NAMES.wait, args: { for: 'text', text: waitFor, timeoutMs: 15_000 } }],
    }
  }
  if (last === NAMES.navigate || last === NAMES.wait) {
    return { tools: [{ name: NAMES.snapshot, args: {} }] }
  }
  const results = since
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message.content))
  return { text: `${BROWSE_HEARD}\n${results.join('\n---\n')}`, pace: 20 }
}
