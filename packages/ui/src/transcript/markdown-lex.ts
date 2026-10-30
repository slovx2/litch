// 回答的 Markdown 切成记号（marked 的 GFM），Markdown.tsx 再把记号变成 React 元素
import { Marked, type Token } from 'marked'
import markedCjkFriendly from 'marked-cjk-friendly'

/**
 * 删除线只认两个波浪号。marked 的 GFM 也认一个的（~删~），中文里“147~155级”“25~30级”这样写范围时，
 * 同一段里两个 ~ 之间就被画成了删除线
 */
const cjk = markedCjkFriendly()
const cjkDel = cjk.tokenizer?.del
const cjkEmphasis = cjk.tokenizer?.emStrong
// 扩展只改解析器的定界符规则，不改原文；代码、链接和原文选区仍由原解析器处理。
const markdown = new Marked(cjk, {
  gfm: true,
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      const token = cjkEmphasis?.call(this, src, maskedSrc, prevChar)
      // 0.1.3 在 CJK 紧贴闭合符时也会接受内侧空白；CommonMark 不允许，手机解析器同样拒绝。
      return token && /^\s|\s$/u.test(token.text) ? undefined : token
    },
    del(src, maskedSrc, prevChar) {
      const token = src.startsWith('~~') ? cjkDel?.call(this, src, maskedSrc, prevChar) : undefined
      return token && /^\s|\s$/u.test(token.text) ? undefined : token
    },
  },
})

export function lex(source: string): Token[] {
  return markdown.lexer(source)
}
