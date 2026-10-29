import { createContext, type ReactNode } from 'react'

/** 文档复用 token 渲染；链接、图片、代码及正文识别由所属表面决定。 */
export interface MarkdownPolicy {
  link(href: string, children: ReactNode): ReactNode
  image(href: string, alt: string): ReactNode
  code(lang: string, text: string): ReactNode
}
export const MarkdownPolicyContext = createContext<MarkdownPolicy | null>(null)
