import { Marked, type Token, type Tokens } from 'marked'

export interface ImageSegment {
  href: string
  alt: string
}
export interface MediaBlock {
  text: string
  images: ImageSegment[]
}
const parser = new Marked({ gfm: true })

/** 原生 Markdown 只接收文字/链接，图片单独交给受控组件。按顶层块保留列表、引用和表格结构。 */
export function mediaBlocks(markdown: string): MediaBlock[] {
  const blocks = parser.lexer(markdown)
  return blocks
    .filter((block) => block.type !== 'def')
    .map((block) => {
      const images: ImageSegment[] = []
      let text = block.raw
      parser.walkTokens([block], (token: Token) => {
        if (token.type !== 'image') return
        const image = token as Tokens.Image
        images.push({ href: image.href, alt: image.text })
        // 说明原样留在图片卡，文字中保留安全链接；编码一次不改源消息。
        const label = (image.text || image.href).replace(/[[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ')
        const href = image.href.replace(/[<>\r\n]/g, (char) => encodeURIComponent(char))
        text = text.replace(image.raw, `[${label}](<${href}>)`)
      })
      // 引用式链接定义一并传入每块，避免拆块后原生解析器丢失其上下文。
      const definitions = blocks
        .filter((token) => token.type === 'def')
        .map((token) => token.raw)
        .join('\n')
      return { text: definitions ? `${text}\n\n${definitions}` : text, images }
    })
}
