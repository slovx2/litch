// biome-ignore-all lint/suspicious/noArrayIndexKey: 解析出来的块和行内片段只按位置区分，流式输出时只在末尾增长，位置就是稳定的身份
// 助手回答的 Markdown 渲染。
// 流式输出时文本每帧都在变，但变的只有结尾：解析只重做最后一块，前面已经稳定的块不重新解析也不重画。
// 解析结果直接变成 React 元素，不经过 HTML 字符串，所以回答里写的任何 HTML 都只会被当成文字显示。
import { repairStreamingMarkdown } from '@litch/core'
import type { Token, Tokens } from 'marked'
import { memo, type ReactNode, useContext, useRef } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import { CiteText, HAS_CITE } from './comments/Cite.tsx'
import { ITEM_ATTR } from './comments/text-range.ts'
import { ExternalLink } from './ExternalLink.tsx'
import { CodeSpan, Link, Prose } from './FileLinks.tsx'
import { languageOf } from './highlight.tsx'
import { MermaidBlock } from './Mermaid.tsx'
import { lex } from './markdown-lex.ts'
import { MarkdownPolicyContext } from './markdown-policy.ts'
import { AnswerMentions, HAS_MENTION } from './SessionMentions.tsx'

interface Parsed {
  /** 已经稳定的那部分源文本，等于 stable 里各块原文的拼接 */
  prefix: string
  stable: Token[]
  all: Token[]
}

/**
 * 增量解析：最后一块之前的都算稳定，下次只要文本还是以它们开头，就只解析后面多出来的部分。
 * 块之间靠引用式链接互相影响的情况很少见，写完之后会整体再解析一次，以那次为准。
 */
function parse(source: string, previous: Parsed | null, final: boolean): Parsed {
  const reuse = !final && previous !== null && source.startsWith(previous.prefix)
  const all = reuse
    ? [...previous.stable, ...lex(source.slice(previous.prefix.length))]
    : lex(source)
  let last = all.length - 1
  while (last >= 0 && all[last]?.type === 'space') last--
  const stable = last > 0 ? all.slice(0, last) : []
  return { prefix: stable.map((token) => token.raw).join(''), stable, all }
}

function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((token, index) => {
    const key = index
    switch (token.type) {
      case 'strong':
        return <strong key={key}>{inline((token as Tokens.Strong).tokens)}</strong>
      case 'em':
        return <em key={key}>{inline((token as Tokens.Em).tokens)}</em>
      case 'del':
        return <del key={key}>{inline((token as Tokens.Del).tokens)}</del>
      case 'codespan':
        // 整段是工作区里的文件路径的能点开（FileLinks.tsx）
        return <PolicyCodeSpan key={key} text={(token as Tokens.Codespan).text} />
      case 'br':
        return <br key={key} />
      case 'link': {
        const link = token as Tokens.Link
        return (
          <PolicyLink key={key} href={link.href}>
            {inline(link.tokens)}
          </PolicyLink>
        )
      }
      case 'image': {
        // 不加载回答里引用的图片（内容安全策略也不允许），只给出它的说明和地址
        const image = token as Tokens.Image
        return <PolicyImage key={key} href={image.href} alt={image.text} />
      }
      case 'text': {
        const text = token as Tokens.Text
        if (text.tokens) return <span key={key}>{inline(text.tokens)}</span>
        // 可能是这一回合用户提到的会话（SessionMentions.tsx）：对得上的画成片，其余照下面的办
        return <PolicyText key={key} text={text.text} />
      }
      default:
        // 转义字符、行内 HTML 和以后新出的类型：按原文显示
        return 'text' in token ? (token as { text: string }).text : token.raw
    }
  })
}

function PolicyText({ text }: { text: string }) {
  const policy = useContext(MarkdownPolicyContext)
  if (policy) return text
  return HAS_MENTION.test(text) ? (
    <AnswerMentions text={text} plain={plainText} />
  ) : (
    plainText(text, 0)
  )
}
function PolicyCodeSpan({ text }: { text: string }) {
  return useContext(MarkdownPolicyContext) ? <code>{text}</code> : <CodeSpan text={text} />
}
function PolicyLink({ href, children }: { href: string; children: ReactNode }) {
  const policy = useContext(MarkdownPolicyContext)
  return policy ? policy.link(href, children) : <Link href={href}>{children}</Link>
}
function PolicyImage({ href, alt }: { href: string; alt: string }) {
  const policy = useContext(MarkdownPolicyContext)
  return policy ? policy.image(href, alt) : <ExternalLink href={href}>{alt || href}</ExternalLink>
}
function PolicyCode({
  code,
  anchor,
  open,
}: {
  code: Tokens.Code
  anchor?: string | undefined
  open: boolean
}) {
  const policy = useContext(MarkdownPolicyContext)
  if (policy) return policy.code(code.lang ?? '', code.text)
  if (languageOf(code.lang ?? '') === 'mermaid')
    return <MermaidBlock anchor={anchor} text={code.text} open={open} />
  return <CodeBlock anchor={anchor} lang={code.lang ?? ''} text={code.text} />
}

/** 回答里一段没有格式的字 */
function plainText(text: string, key: number): ReactNode {
  // 可能是指向评论的 [N]（comments/Cite.tsx）：交给它，认不出照常
  if (HAS_CITE.test(text)) return <CiteText key={key} text={text} />
  // 没有斜杠的字里不会有要认的路径：绝大多数文字照原样出，不多套一层
  return text.includes('/') ? <Prose key={key} text={text} /> : text
}

function listItem(item: Tokens.ListItem, key: number): ReactNode {
  return (
    <li key={key} className={item.task ? 'task' : undefined}>
      {item.tokens.map((token, index) => {
        if (token.type === 'checkbox') {
          return (
            <input key={index} type="checkbox" checked={item.checked === true} readOnly disabled />
          )
        }
        // 紧凑列表里条目的文字是一个 text 块，不包成段落
        if (token.type === 'text')
          return <span key={index}>{inline((token as Tokens.Text).tokens)}</span>
        return block(token, index)
      })}
    </li>
  )
}

/** 围栏代码块的原文以闭合的围栏结尾（流式输出时最后一块可能还没写到那一行） */
const fenceClosed = (raw: string): boolean => /\n {0,3}(`{3,}|~{3,})[ \t]*\n*$/.test(raw)

function block(token: Token, key: number, anchor?: string, open = false): ReactNode {
  const mark = anchor ? { 'data-anchor': anchor } : {}
  switch (token.type) {
    case 'paragraph':
      return (
        <p key={key} {...mark}>
          {inline((token as Tokens.Paragraph).tokens)}
        </p>
      )
    case 'text':
      return (
        <p key={key} {...mark}>
          {inline((token as Tokens.Text).tokens) ?? (token as Tokens.Text).text}
        </p>
      )
    case 'heading': {
      const heading = token as Tokens.Heading
      const Tag = `h${Math.min(6, Math.max(1, heading.depth))}` as 'h1'
      return (
        <Tag key={key} {...mark}>
          {inline(heading.tokens)}
        </Tag>
      )
    }
    case 'code': {
      const code = token as Tokens.Code
      return <PolicyCode key={key} code={code} anchor={anchor} open={open} />
    }
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map(listItem)
      return list.ordered ? (
        <ol key={key} start={typeof list.start === 'number' ? list.start : 1} {...mark}>
          {items}
        </ol>
      ) : (
        <ul key={key} {...mark}>
          {items}
        </ul>
      )
    }
    case 'blockquote':
      return (
        <blockquote key={key} {...mark}>
          {(token as Tokens.Blockquote).tokens.map((child, index) => block(child, index))}
        </blockquote>
      )
    case 'hr':
      return <hr key={key} {...mark} />
    case 'table': {
      const table = token as Tokens.Table
      const align = (index: number) => ({ textAlign: table.align[index] ?? undefined })
      return (
        <div key={key} className="md-table" {...mark}>
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={align(index)}>
                    {inline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={align(index)}>
                      {inline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'space':
    case 'def':
      return null
    default:
      // 块级 HTML 和不认识的类型：按原文显示
      return (
        <p key={key} {...mark}>
          {token.raw}
        </p>
      )
  }
}

/** 一个顶层块。原文没变就不重画：流式输出时只有最后一块在变。open：它是还没写完的围栏代码块 */
const Block = memo(
  function Block({ token, anchor, open }: { token: Token; anchor: string; open: boolean }) {
    return block(token, 0, anchor, open)
  },
  (before, after) =>
    before.token.raw === after.token.raw &&
    before.token.type === after.token.type &&
    before.open === after.open,
)

interface MarkdownProps {
  text: string
  /** 文本还在往外出。这时结尾可能停在没闭合的标记中间，要先补齐再解析 */
  streaming: boolean
  /** 这段回答在滚动定位里的标识，每个顶层块在它后面再加序号 */
  anchor: string
  /** 助手回答所在的条目：给了就能在里面选字加评论（comments/） */
  item?: string
}

export const Markdown = memo(function Markdown({ text, streaming, anchor, item }: MarkdownProps) {
  const cache = useRef<Parsed | null>(null)
  const normalized = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
  const source = streaming ? repairStreamingMarkdown(normalized) : normalized
  const parsed = parse(source, cache.current, !streaming)
  cache.current = parsed
  // 还在往外流时，最后一块要是围栏没闭合的代码块，就是还没写完
  let tail = parsed.all.length - 1
  while (tail >= 0 && parsed.all[tail]?.type === 'space') tail--
  const lastToken = parsed.all[tail]
  const unfinished =
    streaming && lastToken?.type === 'code' && !fenceClosed(lastToken.raw) ? tail : -1
  return (
    // live：样式据此在最后一块的结尾画一个光标
    <div className={streaming ? 'md live' : 'md'} {...(item ? { [ITEM_ATTR]: item } : {})}>
      {parsed.all.map((token, index) =>
        token.type === 'space' ? null : (
          // 块只会在末尾增加，序号就是稳定的键
          <Block
            key={index}
            token={token}
            anchor={`${anchor}:${index}`}
            open={index === unfinished}
          />
        ),
      )}
    </div>
  )
})
