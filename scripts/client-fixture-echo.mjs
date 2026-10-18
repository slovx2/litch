// 隔离环境里的“回声”：让假模型调用桌面端提供的客户端工具 litch_echo.echo（测试用的命名空间），
// 打通“建会话带工具 → 模型调用 → 引擎发 item/tool/call → 桌面端执行 → 结果回到模型”这一整条链路。
// 只有桌面端声明了 litch_echo、建会话时带上了它的工具定义，引擎才会把这个工具交给模型。
//
// 用户的话里带“回声”时，假模型调用 echo，要它原样带回一个记号（带上“要图”时还要一张小图）；工具的结果回来之后
// 把结果里的字原样说出来，回合结束。模型拿到的工具没有 echo（会话不是 Litch 建的、桌面端没声明）时照实说一句。
// 结果是失败的（桌面端关着、拒绝了）时也照实说，开头带着失败的那一行。
import { createHash } from 'node:crypto'

/** 用户的话里有这些字样就调 echo */
export const ECHO_TRIGGER = /回声|echo back/i
/** 回话里这样开头：验收按它认 */
export const ECHO_HEARD = '回声结果：'
export const ECHO_MISSING = '没有 litch_echo 这个工具'

/** Pi 入口给动态工具起的名字（packages/pi/src/dynamic-tools.mts 的 clientTools） */
/**
 * 是不是用户自己说的话。Pi 把工具结果里的图片另起一条 role 为 user 的消息带给模型
 * （开头是 “Attached image(s) from tool result”），那条不算
 */
export const isUserTurn = (message) => {
  if (message?.role !== 'user') return false
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : (content ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('')
  return !text.startsWith('Attached image(s) from tool result')
}

/** 请求里用户说的最后一句话（不算附图的那种） */
export const lastUserText = (body) => {
  const content = body.messages?.findLast(isUserTurn)?.content
  if (typeof content === 'string') return content
  return (content ?? []).map((part) => part.text ?? '').join('')
}

export const piToolName = (namespace, name) =>
  `client_${createHash('sha256')
    .update(JSON.stringify([namespace, name]))
    .digest('hex')
    .slice(0, 32)}`

const ECHO_NAME = piToolName('litch_echo', 'echo')
const nameOf = (tool) => tool?.function?.name ?? tool?.name

/** 一条消息里的字（字符串，或者几段里的文字段） */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('')

/** 一条消息里有没有图 */
const hasImage = (content) =>
  Array.isArray(content) && content.some((part) => part?.type === 'image_url')

/**
 * 这次请求要不要走回声这条路。要的话返回假模型该给的回复，不要就是 null。
 * 要排在提问（client-fixture-ask.mjs 的 askReply）前面：那边见到工具结果就当成是提问的回答
 */
export function echoReply(body, lastUserText) {
  const messages = body.messages ?? []
  const at = messages.findLastIndex((message) => message.role === 'assistant')
  const asked = at < 0 ? null : messages[at]
  const mine = asked?.tool_calls?.some((call) => nameOf(call) === ECHO_NAME)
  if (mine && at < messages.length - 1) {
    // 工具的结果回来了：把里面的字原样说出来，带图的注明一下
    const after = messages.slice(at + 1)
    const said = after
      .filter((message) => message.role === 'tool')
      .map((message) => textOf(message.content))
      .join(' ')
    const image = after.some((message) => hasImage(message.content))
    return { text: `${ECHO_HEARD}${said}${image ? '（带图）' : ''}`, pace: 50 }
  }
  if (!ECHO_TRIGGER.test(lastUserText)) return null
  if (!(body.tools ?? []).some((tool) => nameOf(tool) === ECHO_NAME)) {
    return { text: ECHO_MISSING, pace: 50 }
  }
  const mark = lastUserText.match(/LITCH-[A-Z0-9-]+/)?.[0] ?? 'LITCH-ECHO'
  return {
    tools: [
      {
        name: ECHO_NAME,
        args: {
          text: mark,
          ...(/要图|image/i.test(lastUserText) ? { image: true } : {}),
          ...(/先问|ask first/i.test(lastUserText) ? { ask: true } : {}),
        },
      },
    ],
  }
}
