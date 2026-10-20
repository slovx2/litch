// 选中回答里的一段文字加的评论：发出去时怎么写进正文，对话里又怎么从用户消息里认回来。
// 协议里没有“评论”这种输入，评论拼成正文开头的一段 <litch-comments>，各家 harness 收到的都是普通文字。
// 认回来只看文字本身：原生 CLI 里起的会话、导入的历史也一样认得出，桌面端和手机端用的是同一套。
import type { MessageExtra } from '../model.mjs'

export type CommentExtra = Extract<MessageExtra, { kind: 'comment' }>

/** 一条消息最多带几条评论 */
export const MAX_COMMENTS = 10

/** 引用的原文最长多少个字符，再长的截掉 */
export const MAX_QUOTE = 2000

const TRUNCATED = '… (truncated)'

/** 给模型的那句要求。固定用英文：各家模型都看得懂，认回来时也不看它 */
const ASK =
  'Please respond to each of the following comments on your previous reply, one by one. ' +
  'Mark each response with the number of the comment it answers, like [1] or [2].'

/** 认回来之后的一条评论 */
export interface ParsedComment {
  /** 从 1 开始的编号，回答里的 [N] 指的就是它 */
  index: number
  quote: string
  /** 用户写的评论，没写是空字符串 */
  note: string
}

export interface ParsedComments {
  comments: ParsedComment[]
  /** 评论那一段后面、用户自己打的字 */
  rest: string
}

const TAGS = 'quote|note|comment|litch-comments'
// 原文里正好有收尾标签时改写一下，免得把这一段提前截断；认回来时再改回去
const escapeTags = (value: string) => value.replace(new RegExp(`</(${TAGS})>`, 'gi'), '<\\/$1>')
const unescapeTags = (value: string) => value.replace(new RegExp(`<\\\\/(${TAGS})>`, 'gi'), '</$1>')

/** 引用太长时截掉后面 */
export const clipQuote = (quote: string): string =>
  quote.length > MAX_QUOTE ? quote.slice(0, MAX_QUOTE) + TRUNCATED : quote

/** 几条评论写成正文开头的那一段；没有评论是空字符串 */
export function commentsBlock(comments: CommentExtra[]): string {
  if (comments.length === 0) return ''
  const lines = ['<litch-comments>', ASK]
  comments.forEach((comment, at) => {
    lines.push(`<comment index="${at + 1}">`)
    lines.push(`<quote>${escapeTags(clipQuote(comment.quote))}</quote>`)
    if (comment.note.trim()) lines.push(`<note>${escapeTags(comment.note.trim())}</note>`)
    lines.push('</comment>')
  })
  lines.push('</litch-comments>')
  return lines.join('\n')
}

const HEAD = '<litch-comments>\n'
const TAIL = '\n</litch-comments>'
const ONE =
  /^<comment index="(\d+)">\n<quote>([\s\S]*?)<\/quote>\n(?:<note>([\s\S]*?)<\/note>\n)?<\/comment>(?:\n|$)/

/**
 * 用户消息开头是评论那一段的，拆成评论和后面打的字；不是、或者格式坏了，返回 null，照原文显示。
 * 每一条都要对得上格式、编号从 1 依次往下，有一处不对就整段不认
 */
export function parseComments(text: string): ParsedComments | null {
  if (!text.startsWith(HEAD)) return null
  const end = text.indexOf(TAIL, HEAD.length)
  if (end < 0) return null
  const inner = text.slice(HEAD.length, end)
  const first = inner.indexOf('\n')
  if (first < 0) return null
  let body = inner.slice(first + 1)
  const comments: ParsedComment[] = []
  while (body) {
    const match = ONE.exec(body)
    if (!match) return null
    const index = Number(match[1])
    if (index !== comments.length + 1) return null
    comments.push({
      index,
      quote: unescapeTags(match[2] ?? ''),
      note: unescapeTags(match[3] ?? ''),
    })
    body = body.slice(match[0].length)
  }
  if (comments.length === 0) return null
  const rest = text.slice(end + TAIL.length).replace(/^\n+/, '')
  return { comments, rest }
}
