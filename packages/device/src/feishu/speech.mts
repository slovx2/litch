// 经理发言的内容：把 Markdown 正文分片、按格式拼成飞书的消息体、把 @ 写进正文。
// 有代码块或表格时用卡片（schema 2.0 的 markdown 元素），其余用富文本（md 段落加 at 元素），也可指定纯文本。
// @ 只能经 mentions 参数（设备按成员表解析好的 open_id）；正文里手写的 <at …> 一律打断，防止绕过解析去 @ 所有人。
import type { FeishuOutboxFormat, FeishuPerson } from '../../../protocol/src/feishu.mjs'
import type { ReviewSpeechPart } from '../../../protocol/src/reviews.mjs'

/** 单条消息的正文上限（字符） */
export const SPEECH_CHUNK_LIMIT = 4000
/** 一次发言的正文总长上限 */
export const SPEECH_TEXT_MAX = 40_000
/** 飞书一张卡片里最多几张表格 */
export const CARD_TABLE_LIMIT = 5

export type SpeechMsgType = 'text' | 'post' | 'interactive' | 'image' | 'file'

/** 冻结后的一条：文字类是最终 content；图片文件是待上传的本地副本 */
export interface SpeechPart {
  msgType: SpeechMsgType
  content?: string
  upload?: { kind: 'image' | 'file'; file: string; name: string; size: number }
  /** 经 lark-cli 拦下的原始请求：批了原样发（请求体是冻结目录里的附件文件） */
  raw?: { method: string; pathAndQuery: string; contentType?: string; file: string }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const SEPARATOR_CELL = /^:?-+:?$/

/** 按段落优先切分，段落太长再按行，行太长再硬切 */
export function chunkMarkdown(text: string, limit = SPEECH_CHUNK_LIMIT): string[] {
  const normalized = text.trim()
  if (!normalized) return []
  if (normalized.length <= limit) return [normalized]
  const chunks: string[] = []
  let current = ''
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const candidate = paragraph.trim()
    if (!candidate) continue
    const merged = current ? `${current}\n\n${candidate}` : candidate
    if (merged.length <= limit) {
      current = merged
      continue
    }
    if (current) chunks.push(current)
    current = ''
    chunks.push(...chunkBlock(candidate, limit))
  }
  if (current) chunks.push(current)
  return chunks
}

function chunkBlock(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    let candidate = line
    const merged = current ? `${current}\n${candidate}` : candidate
    if (merged.length <= limit) {
      current = merged
      continue
    }
    if (current) chunks.push(current)
    current = ''
    while (candidate.length > limit) {
      chunks.push(candidate.slice(0, limit).trimEnd())
      candidate = candidate.slice(limit).trimStart()
    }
    current = candidate
  }
  if (current) chunks.push(current)
  return chunks
}

/** 只按没转义的竖线分列，允许省略两侧竖线 */
function tableCells(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let start = 0
  let escaped = false
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') escaped = true
    else if (char === '|') {
      cells.push(trimmed.slice(start, index).trim())
      start = index + 1
    }
  }
  if (cells.length === 0) return []
  cells.push(trimmed.slice(start).trim())
  if (!cells[0]) cells.shift()
  if (cells.length && !cells.at(-1)) cells.pop()
  return cells
}

/** 正文里每张表格的起点（字符偏移），代码块里的不算 */
function tableStarts(text: string): number[] {
  const lines = text.split(/(?<=\n)/)
  const starts: number[] = []
  let offset = 0
  let fence: string | null = null
  let inTable = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const marker = FENCE.exec(line.replace(/\r?\n$/, ''))
    if (fence !== null) {
      if (
        marker?.[1] &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = null
      offset += line.length
      continue
    }
    if (marker?.[1] && (marker[1][0] !== '`' || !marker[2]?.includes('`'))) {
      fence = marker[1]
      inTable = false
      offset += line.length
      continue
    }
    const cells = tableCells(line)
    if (inTable && cells.length) {
      offset += line.length
      continue
    }
    inTable = false
    const next = lines[index + 1]
    if (cells.length && next !== undefined) {
      const separators = tableCells(next)
      if (
        cells.length === separators.length &&
        separators.every((cell) => SEPARATOR_CELL.test(cell))
      ) {
        starts.push(offset)
        inTable = true
      }
    }
    offset += line.length
  }
  return starts
}

/** 卡片：先按表格数分组（每张卡最多 5 张表），组内再按长度分片 */
export function chunkCardMarkdown(
  text: string,
  limit = SPEECH_CHUNK_LIMIT,
  tableLimit = CARD_TABLE_LIMIT,
): string[] {
  const starts = tableStarts(text)
  const boundaries = [0]
  for (let index = tableLimit; index < starts.length; index += tableLimit)
    boundaries.push(starts[index] as number)
  boundaries.push(text.length)
  const chunks: string[] = []
  for (let index = 0; index + 1 < boundaries.length; index++)
    chunks.push(...chunkMarkdown(text.slice(boundaries[index], boundaries[index + 1]), limit))
  return chunks
}

const CODE_BLOCK = /^ {0,3}(```|~~~)/m
const TABLE = /^\s*\|?[^\n|]*\|[^\n]*\n\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/m

/** 有代码块或表格时用卡片，富文本渲染不了它们 */
export function wantsCard(text: string): boolean {
  return CODE_BLOCK.test(text) || TABLE.test(text)
}

/** 打断正文里手写的 <at …>，@ 只能经设备解析过的 mentions */
export function neutralizeMentions(text: string): string {
  return text.replace(/<(\s*)(at)\b/gi, '<\u200b$1$2')
}

const escapeTag = (value: string) => value.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`)

export interface BuiltSpeech {
  format: FeishuOutboxFormat
  parts: SpeechPart[]
  preview: ReviewSpeechPart[]
}

/** 文字类发言：分片并拼成各自的消息体；@ 放在第一条开头 */
export function buildTextSpeech(
  requested: 'auto' | 'text' | 'post' | 'card',
  rawText: string,
  mentions: FeishuPerson[],
  title?: string,
): BuiltSpeech {
  const text = neutralizeMentions(rawText)
  const format = requested === 'auto' ? (wantsCard(text) ? 'card' : 'post') : requested
  const chunks = format === 'card' ? chunkCardMarkdown(text) : chunkMarkdown(text)
  const heading = title?.trim() ? neutralizeMentions(title.trim()).slice(0, 100) : undefined
  const parts: SpeechPart[] = []
  const preview: ReviewSpeechPart[] = []
  const shown = mentions.map((person) => `@${person.name}`).join(' ')
  chunks.forEach((chunk, index) => {
    const people = index === 0 ? mentions : []
    preview.push({
      format,
      text: `${index === 0 && heading ? `${heading}\n\n` : ''}${index === 0 && shown ? `${shown} ` : ''}${chunk}`,
    })
    if (format === 'text') {
      const at = people
        .map((person) => `<at user_id="${person.openId}">${escapeTag(person.name)}</at> `)
        .join('')
      parts.push({ msgType: 'text', content: JSON.stringify({ text: `${at}${chunk}` }) })
    } else if (format === 'post') {
      const paragraph = [
        ...people.map((person) => ({ tag: 'at', user_id: person.openId })),
        { tag: 'md', text: chunk },
      ]
      parts.push({
        msgType: 'post',
        content: JSON.stringify({
          zh_cn: {
            ...(index === 0 && heading ? { title: heading } : {}),
            content: [paragraph],
          },
        }),
      })
    } else {
      const at = people.map((person) => `<at id=${person.openId}></at> `).join('')
      parts.push({
        msgType: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          config: { wide_screen_mode: true },
          ...(index === 0 && heading
            ? { header: { template: 'blue', title: { tag: 'plain_text', content: heading } } }
            : {}),
          body: { elements: [{ tag: 'markdown', content: `${at}${chunk}` }] },
        }),
      })
    }
  })
  return { format, parts, preview }
}
