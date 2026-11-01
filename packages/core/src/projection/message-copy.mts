// 复制消息的可见内容：保留 Markdown 源文，不把评论协议、会话元数据或图片数据写进剪贴板。
import { mentionSegments } from '../../../protocol/src/session-mentions.mjs'
import type { AgentMessageItem, UserAttachment, UserMessageItem } from '../model.mjs'
import { distinctReplies, parseAskReply } from './asks.mjs'
import { parseComments } from './comments.mjs'

export type CopyMessage =
  | Pick<AgentMessageItem, 'kind' | 'text'>
  | Pick<UserMessageItem, 'kind' | 'text' | 'attachments' | 'sessions' | 'peer' | 'system'>

/** 一条回答以 agentMessage 条目为界；分块渲染不改变全文，也不拼接同回合的其他说明。 */
export function messageCopyText(
  item: CopyMessage,
  attachmentName: (attachment: UserAttachment) => string,
): string {
  if (item.kind === 'agentMessage') return item.text
  const parts = item.attachments.map((attachment) => attachment.label ?? attachmentName(attachment))
  // 协作消息和系统消息展开后显示原文，不把其中碰巧相同的标签认成用户评论。
  if (item.peer || item.system) return [...parts, item.text].filter(Boolean).join('\n\n')
  const visible = (text: string) =>
    mentionSegments(text, item.sessions ?? [])
      .map((part) => (part.kind === 'mention' ? part.mention.title : part.text))
      .join('')
  const replies = parseAskReply(item.text)
  const comments = replies ? null : parseComments(item.text)
  if (replies) {
    parts.push(...distinctReplies(replies).map(({ question, answer }) => `${question}\n${answer}`))
  } else if (comments) {
    parts.push(
      ...comments.comments.map(({ index, quote, note }) =>
        [`[${index}] ${quote}`, note].filter(Boolean).join('\n'),
      ),
      visible(comments.rest),
    )
  } else {
    parts.push(visible(item.text))
  }
  return parts.filter(Boolean).join('\n\n')
}
