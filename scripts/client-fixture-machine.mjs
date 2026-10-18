// 隔离环境里的“操作本机”：让假的远程机器上的假模型照用户的原话调用 litch_machine（远程会话操作桌面端那台电脑），
// 或者用 Pi 自己的 bash 跑一条 litch-machine 命令。真实窗口验收用它走一遍开关、卡片、访问范围、进程和复制，
// 模型是回环上的假模型，不花真模型的钱。
//
// 用户的话（一回合一次调用，工具结果回来后把结果原样说出来）：
//   本机：<工具> <JSON 参数>   调 litch_machine.<工具>，比如 本机：exec {"command":"uname -a"}；参数缺省是 {}
//   命令行：<一行命令>         用 Pi 的 bash 跑这行命令（拿来跑 litch-machine，会话号由 Pi 的环境变量带过去）
//   你在哪                     不调工具，把工具说明里写的“你在哪台、控制端是哪台”那一句原样说出来
// 工具不在（会话不是 Litch 建的）时照实说一句。
import { isUserTurn, piToolName } from './client-fixture-echo.mjs'

export const MACHINE_TRIGGER = /本机：(\w+)\s*(\{[\s\S]*\})?/
export const MACHINE_CLI_TRIGGER = /命令行：(.+)/
export const MACHINE_WHERE_TRIGGER = /你在哪/
export const MACHINE_HEARD = '本机结果：'
export const MACHINE_MISSING = '没有 litch_machine 这个工具'

const TOOLS = ['machines', 'exec', 'process', 'read_file', 'write_file', 'list_dir', 'copy']
const NAMES = new Map(TOOLS.map((tool) => [piToolName('litch_machine', tool), tool]))
const BASH = 'bash'
const nameOf = (tool) => tool?.function?.name ?? tool?.name
const descriptionOf = (tool) => tool?.function?.description ?? tool?.description ?? ''
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('')

/** 这次请求要不要走“操作本机”这条路。要的话返回假模型该给的回复，不要就是 null */
export function machineReply(body, lastUserText) {
  const tool = lastUserText.match(MACHINE_TRIGGER)
  const cli = tool ? null : lastUserText.match(MACHINE_CLI_TRIGGER)
  if (!tool && !cli) {
    if (!MACHINE_WHERE_TRIGGER.test(lastUserText)) return null
    // 模型能看到的全部说明（工具和系统提示）里找那一句
    const seen = [
      ...(body.tools ?? []).map(descriptionOf),
      ...(body.messages ?? []).filter((m) => m.role === 'system').map((m) => textOf(m.content)),
    ].join('\n')
    const where = seen.match(/You are running on [^\n]*/)?.[0]
    return {
      text: where ? `我知道的：${where}` : '工具说明里没有写我在哪台设备、控制端是哪台',
      pace: 20,
    }
  }
  const messages = body.messages ?? []
  const since = messages.slice(messages.findLastIndex(isUserTurn) + 1)
  const asked = since.flatMap((message) => message.tool_calls ?? [])
  if (asked.length > 0) {
    const results = since
      .filter((message) => message.role === 'tool')
      .map((message) => textOf(message.content))
    return { text: `${MACHINE_HEARD}\n${results.join('\n---\n')}`, pace: 20 }
  }
  if (cli) return { tools: [{ name: BASH, args: { command: cli[1].trim() } }] }
  const name = [...NAMES].find(([, short]) => short === tool[1])?.[0]
  if (!name) return { text: `litch_machine 里没有 ${tool[1]} 这个工具`, pace: 20 }
  if (!(body.tools ?? []).some((one) => nameOf(one) === name)) {
    return { text: MACHINE_MISSING, pace: 50 }
  }
  let args = {}
  try {
    args = tool[2] ? JSON.parse(tool[2]) : {}
  } catch {
    return { text: `参数不是 JSON：${tool[2]}`, pace: 20 }
  }
  return { tools: [{ name, args }] }
}
