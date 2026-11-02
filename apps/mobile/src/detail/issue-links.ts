// 经理和工作线的对话里，正文出现的看板编号（D-n、I-n、R-n、P-n，带不带 # 都认）改写成 litch-issue: 链接。
// 只认这个经理看板上确有的编号；和 links.ts 一样只换链接不换字形（原文 D-15 还是 D-15），封口的块钉的高度不受影响。
// 页面（经理页、工作线会话页）经上下文给出编号集合和点了之后做什么；普通会话没有这个上下文，什么都不改。
import { createContext } from 'react'

export const ISSUE = 'litch-issue:'

export interface IssueLinks {
  ids: ReadonlySet<string>
  open(id: string): void
}

export const IssueLinksContext = createContext<IssueLinks | null>(null)

/** litch-issue: 链接里的编号；不是这种链接是 null */
export const parseIssueHref = (url: string): string | null =>
  url.startsWith(ISSUE) ? url.slice(ISSUE.length) : null

/** 改写一块 Markdown：代码块、行内代码、已有的链接都不动 */
export function linkIssues(text: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0 || !/[DIRP]-\d/.test(text)) return text
  return text
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[[^\]]*\]\([^)]*\)|<https?:[^>]*>)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/(?<![\w/#-])#?([DIRP]-\d+)(?![\w-])/g, (word, id: string) =>
            ids.has(id) ? `[${word}](${ISSUE}${id})` : word,
          ),
    )
    .join('')
}
