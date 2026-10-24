// 编辑一条发过的用户消息再重发（session.edit）：从对话里那条消息取出能改的文字和能带上的附件，
// 改完拼回要发出去的消息。界面（桌面、手机）都用这两个，规矩只有一份。
// - 评论：不在编辑框里改，原样带上（正文开头那一段，parseComments 认得出的）；
// - 提到的会话：正文里显示的 ＠[标题] 在编辑框里换回输入框里的 @[标题]，发的时候照常带上；
// - 图片：对话里能直接显示的（data URL）原样带上；
// - 带不上的：设备磁盘上的图、音频、提到的文件、技能。对话里只有名字，没有路径、内容，重发时不带（编辑框里写明）。
//   贴进来的长文字发出去时已经并进正文，在编辑框的文字里，不算附件。
import { SENT_SIGIL } from '../../../protocol/src/session-mentions.mjs'
import type { ImageAttachment, MessageExtra, UserAttachment, UserMessageItem } from '../model.mjs'
import { parseComments } from './comments.mjs'
import { isInlineImage } from './items.mjs'

export interface EditableMessage {
  /** 编辑框里的文字 */
  text: string
  /** 原样带上的评论条数（不在编辑框里改） */
  comments: number
  /** 重发时带上的附件（能直接显示的图片） */
  kept: UserAttachment[]
  /** 重发时带不上的附件 */
  dropped: UserAttachment[]
}

const resendable = (attachment: UserAttachment): boolean =>
  attachment.kind === 'image' && typeof attachment.url === 'string' && isInlineImage(attachment.url)

/** 正文去掉评论那一段，提到的会话写回输入框里的样子 */
function editableText(item: UserMessageItem): string {
  const rest = parseComments(item.text)?.rest ?? item.text
  let text = rest
  for (const one of item.sessions ?? [])
    text = text.replaceAll(`${SENT_SIGIL}[${one.title}]`, `@[${one.title}]`)
  return text
}

export function editableOf(item: UserMessageItem): EditableMessage {
  return {
    text: editableText(item),
    comments: parseComments(item.text)?.comments.length ?? 0,
    kept: item.attachments.filter(resendable),
    dropped: item.attachments.filter((attachment) => !resendable(attachment)),
  }
}

/** 编辑后的文字拼回要发出去的消息（session.edit、发送失败时放回输入框都用它） */
export function resendOf(
  item: UserMessageItem,
  text: string,
): { text: string; images: ImageAttachment[]; extras: MessageExtra[] } {
  const comments = (parseComments(item.text)?.comments ?? []).map(
    ({ quote, note }): MessageExtra => ({ kind: 'comment', itemId: item.id, quote, note }),
  )
  const sessions = (item.sessions ?? []).map(
    ({ threadId, title }): MessageExtra => ({ kind: 'session', threadId, title }),
  )
  return {
    text,
    images: item.attachments.filter(resendable).map((image) => ({
      url: image.url as string,
      name: image.label,
    })),
    extras: [...comments, ...sessions],
  }
}
