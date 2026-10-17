import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// OpenCode 的消息号：msg_ 加 26 位，前 12 位是十六进制的“毫秒时间戳 × 4096 + 同一毫秒里的序号”，其余随机，
// 按字面排序就是先后（OpenCode 的 packages/schema/src/identifier.ts）。适配器发消息时自己生成消息号交给它，
// 回合号就用这个号，回合一开始就有、和 OpenCode 记下的那条用户消息对得上。
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastTimestamp = 0
let counter = 0
export function messageId(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter += 1
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = value.toString(16).padStart(12, '0').slice(-12)
  const random = Array.from(randomBytes(14), (byte) => CHARS[byte % 62]).join('')
  return `msg_${time}${random}`
}

export interface PromptInput {
  /** 交给 OpenCode 的部件：文字、图片和文件引用（file 部件） */
  parts: any[]
  /** 点名的技能或命令（协议输入里的 skill）：有的话这一轮经 /command 发，别的文字是它的参数 */
  command: string | null
  /** 文字部分连起来（命令的参数） */
  text: string
}

function mediaOf(path: string): string {
  const media = MEDIA[extname(path).toLowerCase()]
  if (!media) throw new ProtocolError(-32602, `不支持的图片类型: ${path}`)
  return media
}

// 文件引用交给 OpenCode 的样子和它自己的 @文件 一样：file:// 地址的 file 部件，OpenCode 读出内容放进上下文
//（目录列出里面有什么，图片转成内联的）。
function mentionPart(path: string, name: string): any {
  let directory = false
  try {
    directory = statSync(path).isDirectory()
  } catch {}
  return {
    type: 'file',
    mime: directory ? 'application/x-directory' : 'text/plain',
    url: pathToFileURL(path).href,
    filename: name || basename(path),
  }
}

/** Codex 的输入条目转成 OpenCode 的部件 */
export function promptInput(input: any[]): PromptInput {
  if (!Array.isArray(input)) throw new ProtocolError(-32602, 'input 必须是数组')
  const parts: any[] = []
  const texts: string[] = []
  let command: string | null = null
  for (const item of input) {
    if (item?.type === 'text') {
      texts.push(String(item.text ?? ''))
      parts.push({ type: 'text', text: String(item.text ?? '') })
    } else if (item?.type === 'skill') {
      if (command) throw new ProtocolError(-32602, 'OpenCode 一句话里只能点名一个技能或命令')
      command = String(item.name ?? '')
      if (!command) throw new ProtocolError(-32602, '技能名不能为空')
    } else if (item?.type === 'mention') parts.push(mentionPart(String(item.path), item.name))
    else if (item?.type === 'localImage') {
      const path = String(item.path ?? '')
      parts.push({
        type: 'file',
        mime: mediaOf(path),
        url: pathToFileURL(path).href,
        filename: basename(path),
      })
    } else if (item?.type === 'image') {
      const match = /^data:([^;,]+);base64,/.exec(String(item.url ?? ''))
      if (!match) throw new ProtocolError(-32602, 'OpenCode 图片输入需要 data URL 或本地文件')
      parts.push({ type: 'file', mime: match[1], url: item.url, filename: 'image' })
    } else throw new ProtocolError(-32602, `不支持输入类型: ${item?.type}`)
  }
  const text = texts.join('\n')
  if (!command && !text.trim() && !parts.some((part) => part.type === 'file'))
    throw new ProtocolError(-32602, '输入不能为空')
  return { parts, command, text }
}

// 客户端发来的输入里要记下来的那一份：回给客户端的用户消息就是它，发来是什么样回去就是什么样
//（图片带地址的还是带地址、本地文件还是那个路径、技能还是一项技能）。只留协议里有的字段。
export function echoContent(input: any[]): any[] {
  return input.map((item) => {
    const detail = typeof item.detail === 'string' ? { detail: item.detail } : {}
    if (item.type === 'text')
      return {
        type: 'text',
        text: item.text,
        text_elements: Array.isArray(item.text_elements) ? item.text_elements : [],
      }
    if (item.type === 'image') return { type: 'image', url: item.url, ...detail }
    if (item.type === 'localImage') return { type: 'localImage', path: item.path, ...detail }
    return { type: item.type, name: String(item.name ?? ''), path: String(item.path ?? '') }
  })
}
