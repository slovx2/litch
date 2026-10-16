// 隔离环境里的“跑命令”：让假模型能调用 Pi 内置的 bash 工具，
// 这样打开 Pi 的审批（设置 harness.pi.approvals）之后，客户端上看得到真实引擎发来的命令审批卡片。
//
// 用户的话里带“跑个命令”时，假模型调用 bash 跑一条固定的、没有害处的命令；
// 工具的结果回来之后把它带在回话里。命令被拒绝时，结果就是拒绝的原因（连同用户附的说明），同样带回来。
//   用户：跑个命令
//   → （审批开着）一张命令审批卡片：批准，或者拒绝
//   → 回话里是命令的输出，或者拒绝的原因

/** Pi 内置的跑命令的工具 */
export const RUN_TOOL = 'bash'

/** 用户的话里有这些字样就跑命令 */
export const RUN_TRIGGER = /跑个命令|run a command/i

/** 跑的命令：在工作目录里留一个文件，验收可以据此确认它到底跑没跑 */
export const RUN_MARK = 'fixture-ran.txt'
export const RUN_COMMAND = `echo fixture-ran-$((6*7)) | tee ${RUN_MARK}`

const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')

const nameOf = (tool) => tool?.function?.name ?? tool?.name

/**
 * 这次请求要不要走跑命令这条路。要的话返回假模型该给的回复，不要就是 null。
 * 要排在提问（client-fixture-ask.mjs 的 askReply）前面：那边见到工具结果就当成是提问的回答。
 */
export function runReply(body, lastUserText) {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    // 只认自己发起的那次调用的结果
    const asked = messages.findLast((message) => message.role === 'assistant' && message.tool_calls)
    if (!asked?.tool_calls.some((call) => nameOf(call) === RUN_TOOL)) return null
    return {
      text: `命令的结果：\n\n${textOf(last.content)}\n\n这是隔离环境里的假模型在回话。`,
      pace: 200,
    }
  }
  if (!RUN_TRIGGER.test(lastUserText)) return null
  if (!(body.tools ?? []).some((tool) => nameOf(tool) === RUN_TOOL)) return null
  return { tools: [{ name: RUN_TOOL, args: { command: RUN_COMMAND } }] }
}
