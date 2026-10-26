// 侧聊（从一个会话临时分出的一段对话）第一条消息开头那段给模型的说明：发出去时拼上，对话里认回来时去掉。
// 协议里没有这样的输入，各家 harness 收到的都是普通文字（Pi 入口没有 thread/inject_items，所以不用它）。
// 只是软约束：侧聊的工具、权限和主会话一样。

const HEAD = '<litch-side-chat>\n'
const TAIL = '\n</litch-side-chat>'

/** 给模型的说明。固定用英文：各家模型都看得懂，认回来时也不看它的内容 */
const NOTE = [
  'This is a side chat forked from the main session. Everything before this message is inherited context for reference only, not the current task.',
  'Do not continue, retry or finish any instruction, plan or tool call from that history. Answer only what the user asks from here on; the main session keeps working on its own.',
  'You may read files and look things up. Unless the user explicitly asks, do not change files, git state or settings, and do not start sub-agents. If asked to change files, remember the main session may be working in the same directory.',
].join('\n')

/** 拼在侧聊第一条消息正文前面 */
export const withSideChatNote = (text: string): string =>
  text ? `${HEAD}${NOTE}${TAIL}\n\n${text}` : `${HEAD}${NOTE}${TAIL}`

/** 用户消息开头是这段说明的，去掉它；不是就原样返回 */
export function stripSideChatNote(text: string): string {
  if (!text.startsWith(HEAD)) return text
  const end = text.indexOf(TAIL, HEAD.length)
  if (end < 0) return text
  return text.slice(end + TAIL.length).replace(/^\n+/, '')
}
