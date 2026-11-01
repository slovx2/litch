// 和对话正文使用同一个 Markdown lexer；行内节点之间不插空格，块之间保留分隔。
import type { Token, Tokens } from 'marked'
import { lex } from '../markdown-lex.ts'

function inline(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'image') {
        const image = token as Tokens.Image
        return image.text || image.href
      }
      if (token.type === 'br') return '\n'
      if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : token.raw
    })
    .join('')
}
function blocks(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'space' || token.type === 'hr') return ''
      if (token.type === 'list')
        return (token as Tokens.List).items.map((item) => blocks(item.tokens)).join('\n')
      if (token.type === 'blockquote') return blocks((token as Tokens.Blockquote).tokens)
      if (token.type === 'table') {
        const table = token as Tokens.Table
        return [table.header, ...table.rows]
          .map((row) => row.map((cell) => inline(cell.tokens)).join('\n'))
          .join('\n')
      }
      if (token.type === 'code') return (token as Tokens.Code).text
      if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : token.raw
    })
    .join('\n')
}
export function markdownSearchText(text: string): string {
  return blocks(lex(text))
}
