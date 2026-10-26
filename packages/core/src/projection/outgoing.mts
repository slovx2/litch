// 要发出去的消息：界面给的文字、图片和别的附带项 → 协议里的输入，以及不等对面、先显示出来的那条用户消息。
import type { UserInput } from '../../../protocol/src/index.mjs'
import {
  matchMentions,
  mentionTitle,
  SESSION_MENTION_LIMITS,
  sentText,
  sessionMentionsBlock,
} from '../../../protocol/src/session-mentions.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type {
  ImageAttachment,
  MessageExtra,
  OutgoingMessage,
  UserAttachment,
  UserMessageItem,
} from '../model.mjs'
import { type CommentExtra, commentsBlock, MAX_COMMENTS } from './comments.mjs'
import { isInlineImage, withSessionMentions, withSystemMessage } from './items.mjs'

type SessionExtra = Extract<MessageExtra, { kind: 'session' }>

/** 一条消息最多带几张图。再多的话一帧就太大了（服务端一帧的上限是 100 MiB） */
export const MAX_IMAGES = 8

/** 一条消息最多带几样图片之外的东西 */
export const MAX_EXTRAS = 16

/** 名字、路径这类短字段最长多少个字符 */
const MAX_FIELD = 4096

/** 一段带着的文字最长多少个字符。再长的话并进正文之后一条消息就太大了 */
export const MAX_EXTRA_TEXT = 1_000_000

const short = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD

/** 附带项是界面给的，形状再查一遍：不对的不发，也不带着多余的字段出去 */
function checkExtra(extra: MessageExtra): MessageExtra {
  if (extra?.kind === 'skill' && short(extra.name) && short(extra.path)) {
    return { kind: 'skill', name: extra.name, path: extra.path }
  }
  if (
    extra?.kind === 'text' &&
    typeof extra.text === 'string' &&
    extra.text.trim() !== '' &&
    extra.text.length <= MAX_EXTRA_TEXT &&
    (extra.name === null || short(extra.name))
  ) {
    return { kind: 'text', name: extra.name, text: extra.text }
  }
  if (extra?.kind === 'file' && short(extra.name) && short(extra.path)) {
    return { kind: 'file', name: extra.name, path: extra.path }
  }
  if (
    extra?.kind === 'comment' &&
    short(extra.itemId) &&
    typeof extra.quote === 'string' &&
    extra.quote.trim() !== '' &&
    extra.quote.length <= MAX_EXTRA_TEXT &&
    typeof extra.note === 'string' &&
    extra.note.length <= MAX_EXTRA_TEXT
  ) {
    return { kind: 'comment', itemId: extra.itemId, quote: extra.quote, note: extra.note }
  }
  // 提到的会话：标题照写进正文的样子整理一遍（界面也是这样写的，对不上的发的时候自然不带）；核心补的 ref 不收界面给的
  if (extra?.kind === 'session' && short(extra.threadId) && typeof extra.title === 'string') {
    const title = mentionTitle(extra.title)
    if (title) return { kind: 'session', threadId: extra.threadId, title }
  }
  throw new ChannelError('rejected', '消息附件无效')
}

/** 带着的一段文字并进正文时的样子：有名字的（一个文件的内容）前面加一行名字，对面才知道这是哪个文件 */
export const textOf = (extra: Extract<MessageExtra, { kind: 'text' }>): string =>
  extra.name === null ? extra.text : `${extra.name}:\n${extra.text}`

/**
 * 真正发出去的正文：评论那一段在最前面，然后是打的字，带着的几段文字依次跟在后面，中间空一行。
 * 协议里没有“文本附件”，对面收到的就是这样一整段，和把那几段直接贴进输入框是一回事。
 * mentions 是这个 harness 收不收指向文件的 mention：不收的话，提到的文件的路径也写进正文，一行一个，排在后面。
 * 提到了会话的，打的字里的 @[标题] 换成 ＠[标题]，最后是列出这些会话的那一段（session-mentions.mts）
 */
export function bodyOf(
  { text, extras }: Pick<OutgoingMessage, 'text' | 'extras'>,
  mentions: boolean,
): string {
  const comments = extras.filter((extra): extra is CommentExtra => extra.kind === 'comment')
  const sessions = extras.filter((extra): extra is SessionExtra => extra.kind === 'session')
  const said = sessions.length
    ? sentText(
        text,
        sessions.map((one) => one.title),
      )
    : text
  const parts = [commentsBlock(comments), said.trim() ? said : '']
  for (const extra of extras) if (extra.kind === 'text') parts.push(textOf(extra))
  if (!mentions) {
    const paths = extras.flatMap((extra) => (extra.kind === 'file' ? [extra.path] : []))
    parts.push(paths.join('\n'))
  }
  parts.push(
    sessionMentionsBlock(
      sessions.map((one) => one.ref ?? { threadId: one.threadId, title: one.title }),
    ),
  )
  return parts.filter(Boolean).join('\n\n')
}

/** 界面给的东西先过一遍：空消息、不是图片的附件、形状不对的附带项都不收 */
export function outgoing(
  text: string,
  images: ImageAttachment[] = [],
  extras: MessageExtra[] = [],
): OutgoingMessage {
  if (images.length > MAX_IMAGES) throw new ChannelError('rejected', '图片过多')
  for (const image of images) {
    if (!isInlineImage(image.url)) throw new ChannelError('rejected', '附件不是可发送的图片')
  }
  if (extras.length > MAX_EXTRAS) throw new ChannelError('rejected', '附件过多')
  const listed = extras.map(checkExtra)
  if (listed.filter((extra) => extra.kind === 'comment').length > MAX_COMMENTS) {
    throw new ChannelError('rejected', '评论过多')
  }
  // 提到的会话只留正文里还写着的，按出现的先后排（输入框里把 @[标题] 删掉了就不带）
  const sessions = matchMentions(
    text,
    listed.filter((extra): extra is SessionExtra => extra.kind === 'session'),
  )
  if (sessions.length > SESSION_MENTION_LIMITS.perMessage) {
    throw new ChannelError('rejected', '提到的会话过多')
  }
  const checked = [...listed.filter((extra) => extra.kind !== 'session'), ...sessions]
  if (!text.trim() && images.length === 0 && checked.length === 0) {
    throw new ChannelError('rejected', '消息为空')
  }
  return { text, images: images.map(({ url, name }) => ({ url, name })), extras: checked }
}

export function toInput(message: OutgoingMessage, mentions: boolean): UserInput[] {
  const { images, extras } = message
  const input: UserInput[] = []
  // 技能排在最前面：适配器的引擎把它化成一句“/名字”交给 harness，那一句要在话的开头才算数
  for (const extra of extras) {
    if (extra.kind === 'skill') input.push({ type: 'skill', name: extra.name, path: extra.path })
  }
  // 只有图片的消息不带空的文字段：有的引擎不收空文字
  const text = bodyOf(message, mentions)
  if (text) input.push({ type: 'text', text, text_elements: [] })
  // 提到的文件跟在话后面：适配器的引擎把它化成一行路径（Claude Code 是 @路径）接在话的后面
  if (mentions) {
    for (const extra of extras) {
      if (extra.kind === 'file') input.push({ type: 'mention', name: extra.name, path: extra.path })
    }
  }
  for (const image of images) input.push({ type: 'image', url: image.url })
  return input
}

/**
 * 附带项在对话里显示成什么。顺序和发出去的输入一致，对面回显时落在同样的位置上。
 * 带着的文字、评论已经并进正文了，不另外显示；提到的文件也一样，除非它是用 mention 带过去的
 */
const shown = (extras: MessageExtra[], mentions: boolean): UserAttachment[] => [
  ...extras.flatMap((extra): UserAttachment[] =>
    extra.kind === 'skill' ? [{ kind: 'skill', label: extra.name }] : [],
  ),
  ...extras.flatMap((extra): UserAttachment[] =>
    extra.kind === 'file' && mentions ? [{ kind: 'file', label: extra.name }] : [],
  ),
]

/** 不等对面、先显示出来的那条用户消息。提到会话的那一段、“在这里做”这类 Litch 替用户发的话和对面回显的一样认出来 */
export const localUserMessage = (
  id: string,
  message: OutgoingMessage,
  mentions: boolean,
): UserMessageItem =>
  withSessionMentions(
    withSystemMessage({
      id,
      kind: 'userMessage',
      text: bodyOf(message, mentions),
      attachments: [
        ...shown(message.extras, mentions),
        ...message.images.map(
          (image): UserAttachment => ({ kind: 'image', label: image.name, url: image.url }),
        ),
      ],
    }),
  )
