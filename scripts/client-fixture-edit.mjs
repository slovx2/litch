// 隔离环境里的“改文件”：让假模型调用 Pi 内置的 bash 工具，在会话的工作目录里改一个文件、新写一个文件。
// 差异面板的验收拿它看“代理改完文件，回合结束后面板自己跟上”。
//
// 用户的话里带“改个文件”时，假模型调用 bash 跑一条固定的命令；工具的结果回来之后回一句话，回合结束。
// 只往会话自己的工作目录里写（夹具的临时目录），不碰别处。

/** Pi 内置的跑命令的工具 */
const EDIT_TOOL = 'bash'

/** 用户的话里有这些字样就改文件 */
export const EDIT_TRIGGER = /改个文件|edit a file/i

/** 被接着写的文件、新写的文件：验收按这两个名字去找 */
export const EDIT_APPENDED = 'agent-notes.txt'
export const EDIT_CREATED = 'agent-new.ts'
export const EDIT_COMMAND = `echo "agent edit" >> ${EDIT_APPENDED} && echo "export const fresh = true" > ${EDIT_CREATED}`

const nameOf = (tool) => tool?.function?.name ?? tool?.name

/**
 * 这次请求要不要走改文件这条路。要的话返回假模型该给的回复，不要就是 null。
 * 要排在提问（client-fixture-ask.mjs 的 askReply）前面：那边见到工具结果就当成是提问的回答。
 */
export function editReply(body, lastUserText) {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    // 只认自己发起的那次调用的结果
    const asked = messages.findLast((message) => message.role === 'assistant' && message.tool_calls)
    const mine = asked?.tool_calls.some((call) => {
      if (nameOf(call) !== EDIT_TOOL) return false
      return String(call.function?.arguments ?? '').includes(EDIT_CREATED)
    })
    if (!mine) return null
    return { text: `改好了：接着写了 ${EDIT_APPENDED}，新写了 ${EDIT_CREATED}。`, pace: 150 }
  }
  if (!EDIT_TRIGGER.test(lastUserText)) return null
  if (!(body.tools ?? []).some((tool) => nameOf(tool) === EDIT_TOOL)) return null
  return { tools: [{ name: EDIT_TOOL, args: { command: EDIT_COMMAND } }] }
}
