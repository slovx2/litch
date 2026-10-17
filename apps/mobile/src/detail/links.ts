// 对话里能点的字：工作区里的文件路径（点了到“文件”页，定位到行）、网址（交给系统浏览器）。
// Markdown 组件只认链接，所以在交给它之前把这两种字改写成链接：
// - 行内代码整段是个路径的，改成 [`路径`](litch-file:…)，样子还是行内代码；
// - 正文里扫出来的路径（核心的 findFileRefs，认不准的宁可不认）改成 [路径](litch-file:…)；
// - 裸写的 http(s) 地址改成 <地址>，Markdown 的自动链接。
// 代码块里的一律不动；一行里已经有链接（`](`、`<http`）的整行不动，免得拆坏原有的链接。
// 改写只换链接、不换字形：封口的块排好版钉了高度（cells.tsx），改写前后排出来要一样高。
import { type FileRef, type FileScope, fileRefOf, findFileRefs } from '@litch/core'

const FILE = 'litch-file:'
/** 一段正文里的裸网址。结尾的句读不算 */
const URL = /https?:\/\/[^\s<>()[\]`"'，。；：！？、（）]+/g
const TRAILING = /[.,;:!?]+$/
/** 单个反引号围起来的行内代码 */
const CODE = /`([^`\n]+)`/g

/** 路径里的括号也要转义：Markdown 的链接地址遇到右括号就结束了 */
const encodePath = (path: string): string =>
  encodeURIComponent(path).replace(/\(/g, '%28').replace(/\)/g, '%29')

export function fileHref(ref: FileRef): string {
  return `${FILE}${encodePath(ref.path)}${ref.line === null ? '' : `#L${ref.line}`}`
}

/** litch-file: 链接里的路径和行号。不是这种链接是 null */
export function parseFileHref(url: string): { path: string; line: number | null } | null {
  if (!url.startsWith(FILE)) return null
  const rest = url.slice(FILE.length)
  const hash = rest.indexOf('#L')
  try {
    const path = decodeURIComponent(hash < 0 ? rest : rest.slice(0, hash))
    const line = hash < 0 ? null : Number(rest.slice(hash + 2))
    return { path, line: line !== null && Number.isInteger(line) && line > 0 ? line : null }
  } catch {
    return null
  }
}

export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** 改写一块 Markdown。scope 是 null（还不知道工作区）时只认网址 */
export function linkify(text: string, scope: FileScope | null): string {
  const paths = scope !== null && (text.includes('/') || text.includes('`'))
  if (!paths && !text.includes('://')) return text
  const lines = text.split('\n')
  let fence: string | null = null
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const trimmed = line.trimStart()
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null
      continue
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3)
      continue
    }
    // 缩进四格的是代码块（在列表里的也可能是续行，不碰它最稳）
    if (/^( {4}|\t)/.test(line) || line.includes('](') || line.includes('<http')) continue
    const next = linkLine(line, paths ? scope : null)
    if (next !== line) {
      lines[index] = next
      changed = true
    }
  }
  return changed ? lines.join('\n') : text
}

function linkLine(line: string, scope: FileScope | null): string {
  let out = ''
  let at = 0
  for (const match of line.matchAll(CODE)) {
    out += linkProse(line.slice(at, match.index), scope)
    const code = match[1] ?? ''
    const ref = scope ? fileRefOf(code, scope, 'code') : null
    out += ref ? `[${match[0]}](${fileHref(ref)})` : match[0]
    at = match.index + match[0].length
  }
  // 反引号没配对（流式到一半）：后面的照正文处理也不会出错，链接不会跨过反引号
  return out + linkProse(line.slice(at), scope)
}

function linkProse(text: string, scope: FileScope | null): string {
  if (!text) return text
  const spans: { start: number; end: number; with: string }[] = []
  if (text.includes('://')) {
    for (const match of text.matchAll(URL)) {
      const url = match[0].replace(TRAILING, '')
      spans.push({ start: match.index, end: match.index + url.length, with: `<${url}>` })
    }
  }
  if (scope && text.includes('/')) {
    for (const span of findFileRefs(text, scope)) {
      const raw = text.slice(span.start, span.end)
      spans.push({ start: span.start, end: span.end, with: `[${raw}](${fileHref(span.ref)})` })
    }
  }
  if (spans.length === 0) return text
  spans.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const span of spans) {
    if (span.start < at) continue
    out += text.slice(at, span.start) + span.with
    at = span.end
  }
  return out + text.slice(at)
}
