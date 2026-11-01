// 共用对话的 Markdown 解析和安全链接；看板只在正文与行内代码里识别对象编号。
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { Markdown } from '../transcript/Markdown.tsx'
import { type MarkdownPolicy, MarkdownPolicyContext } from '../transcript/markdown-policy.ts'
import { BoardReferences } from './BoardReferences.tsx'

const plain: MarkdownPolicy = {
  // 链接标题不再嵌套编号按钮，保留作者明确指定的链接目标。
  link: (href, children) => (
    <MarkdownPolicyContext.Provider value={plain}>
      <ExternalLink href={href}>{children}</ExternalLink>
    </MarkdownPolicyContext.Provider>
  ),
  image: (href, alt) => <ExternalLink href={href}>{alt || href}</ExternalLink>,
  code: (_lang, text) => (
    <pre>
      <code>{text}</code>
    </pre>
  ),
}
const policy: MarkdownPolicy = {
  ...plain,
  text: (text) => <BoardReferences text={text} />,
  codeSpan: (text) => (
    <code>
      <BoardReferences text={text} />
    </code>
  ),
}

export function BoardMarkdown({ text }: { text: string }) {
  return (
    <div className="mg-markdown">
      <MarkdownPolicyContext.Provider value={policy}>
        <Markdown text={text} streaming={false} anchor="manager-board" />
      </MarkdownPolicyContext.Provider>
    </div>
  )
}
