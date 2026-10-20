// 随消息带的、图片之外的东西（核心里的 MessageExtra）在输入区里的几条规矩。
// 纯逻辑：test/extras.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。
import type { MessageExtra, PathTwin } from '@litch/core'

/** 一条消息最多带几样。和核心收的上限一致（核心里的 MAX_EXTRAS） */
export const EXTRAS_LIMIT = 16

/** 一段带着的文字最长多少个字符。和核心收的上限一致（核心里的 MAX_EXTRA_TEXT） */
export const TEXT_LIMIT = 1_000_000

/**
 * 贴进来的文字超过这么多就不塞进输入框，转成一段带着的文字：字符数或者行数，过了哪一条都算。
 * 字符按字符串的长度数（和输入框、核心的上限是同一种数法，一个汉字算一个），行按换行数。
 * 输入框最多显示十来行，三十行的东西贴进去前后都看不见了；两千个字符大约是一屏半的正文。
 */
export const PASTE_CHARS = 2000
export const PASTE_LINES = 30

/** 各家系统的换行统一成一种，行数才数得准 */
export const tidyText = (raw: string): string => raw.replace(/\r\n?/g, '\n')

/** 一段文字有几行。末尾的空行不算 */
export function lineCount(text: string): number {
  const body = text.replace(/\n+$/, '')
  if (!body) return 0
  let lines = 1
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) lines += 1
  return lines
}

/** 贴进来的一段文字怎么办：inline 照常进输入框；attach 转成带着的文字；long 太长了，带不上 */
export function pasteVerdict(text: string): 'inline' | 'attach' | 'long' {
  if (text.length > TEXT_LIMIT) return 'long'
  return text.length > PASTE_CHARS || lineCount(text) > PASTE_LINES ? 'attach' : 'inline'
}

/** 一片上写什么。技能是它叫出来时的样子（斜杠加名字）；没有名字的文字（贴进来的）由界面按语言另说，这里给 null */
export const extraLabel = (extra: MessageExtra): string | null => {
  if (extra.kind === 'skill') return `/${extra.name}`
  // 评论在排队的那一行上只写引用的开头
  if (extra.kind === 'comment') {
    const quote = extra.quote.replace(/\s+/g, ' ').trim()
    return quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
  }
  return extra.name
}

/** 是不是同一样东西 */
export const sameExtra = (a: MessageExtra, b: MessageExtra): boolean => {
  if (a.kind === 'text') return b.kind === 'text' && a.name === b.name && a.text === b.text
  if (a.kind === 'comment') {
    return b.kind === 'comment' && a.itemId === b.itemId && a.quote === b.quote && a.note === b.note
  }
  if (b.kind === 'text' || b.kind === 'comment') return false
  return b.kind === a.kind && a.path === b.path
}

/** full 在 base 下面时相对 base 的写法，不在是 null */
const under = (base: string, full: string | null): string | null =>
  full?.startsWith(`${base}/`) ? full.slice(base.length + 1) : null

/**
 * 别处（文件面板的“加入对话”）交过来的一个文件或目录，变成随消息带的那一片。
 * 路径照 harness 认的写：在会话的工作目录里面就写相对它的（和打 @ 选中的一样），不在里面、或者还没有工作目录，写完整的。
 * 目录后面带一个斜杠。twin 是路径的另一种写法（核心的 pathTwin，macOS 上 /private/var 和 /var 是一处），
 * 文件和工作目录写法不一样时靠它对上
 */
export function fileExtra(
  file: { full: string; dir: boolean },
  cwd: string | null,
  twin: PathTwin = () => null,
): MessageExtra {
  const full = file.full.replace(/\/+$/, '')
  const base = cwd?.replace(/\/+$/, '')
  const inside = (base && (under(base, full) ?? under(base, twin(full)))) || full
  const path = file.dir ? `${inside}/` : inside
  return { kind: 'file', name: path.slice(inside.lastIndexOf('/') + 1), path }
}

/**
 * 把一段带着的文字放回正文：接在已经打的字后面，空一行。和发出去时并回正文的样子一致
 * （核心里的 bodyOf、textOf）：有名字的那一段（一个文件的内容）前面有一行名字
 */
export function inlineText(body: string, extra: Extract<MessageExtra, { kind: 'text' }>): string {
  const text = extra.name === null ? extra.text : `${extra.name}:\n${extra.text}`
  return body.trim() ? `${body.replace(/\n+$/, '')}\n\n${text}` : text
}

/**
 * 往已经带着的里面再加几样。
 * 技能一条消息只带一项，后选的换掉先选的：几个引擎都是把它化成话开头的一句“/名字”，一句话只认开头的那一项，
 * 带两项的话第二项到不了 harness 手里。同一个文件不提两遍。
 * 贴进来的文字贴几次带几段（同一段贴了两遍，片也是两片，看得见、拿得掉）。超出上限的不要。
 */
export function mergeExtras(
  list: readonly MessageExtra[],
  more: readonly MessageExtra[],
): MessageExtra[] {
  let next = [...list]
  for (const extra of more) {
    if (extra.kind === 'skill') next = [extra, ...next.filter((have) => have.kind !== 'skill')]
    else if (extra.kind === 'text' || !next.some((have) => sameExtra(have, extra))) next.push(extra)
  }
  return next.slice(0, EXTRAS_LIMIT)
}
