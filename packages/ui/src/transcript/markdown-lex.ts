// 回答的 Markdown 切成记号（marked 的 GFM），Markdown.tsx 再把记号变成 React 元素
import { Lexer, type Token, Tokenizer } from 'marked'

/**
 * 删除线只认两个波浪号。marked 的 GFM 也认一个的（~删~），中文里“147~155级”“25~30级”这样写范围时，
 * 同一段里两个 ~ 之间就被画成了删除线
 */
class Tildes extends Tokenizer {
  override del(...args: Parameters<Tokenizer['del']>): ReturnType<Tokenizer['del']> {
    const token = super.del(...args)
    return token?.raw.startsWith('~~') ? token : undefined
  }
}

export function lex(source: string): Token[] {
  return new Lexer({ gfm: true, tokenizer: new Tildes() }).lex(source)
}
