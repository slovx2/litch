import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// Codex 输入条目转成 dsh 的提示词内容；文本合并为一段，图片按 base64 内联。
// 技能写成单独一行的“/名字”：dsh 认的是话里前后都是空白的这样一个词，不要求在开头。
export async function promptContent(input: any[]): Promise<any[]> {
  if (!Array.isArray(input)) throw new ProtocolError(-32602, 'input 必须是数组')
  const parts: string[] = []
  const images: any[] = []
  for (const item of input) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type === 'skill') parts.push(`/${item.name}`)
    else if (item.type === 'mention') parts.push(item.path)
    else if (item.type === 'localImage') {
      const mediaType = MEDIA[extname(item.path).toLowerCase()]
      if (!mediaType) throw new ProtocolError(-32602, `不支持的图片类型: ${item.path}`)
      images.push({
        type: 'image',
        mediaType,
        data: (await readFile(item.path)).toString('base64'),
      })
    } else if (item.type === 'image') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.url ?? '')
      if (!match) throw new ProtocolError(-32602, 'dsh 图片输入需要 data URL 或本地文件')
      images.push({ type: 'image', mediaType: match[1], data: match[2] })
    } else throw new ProtocolError(-32602, `不支持输入类型: ${item.type}`)
  }
  const text = parts.join('\n')
  if (!text.trim() && !images.length) throw new ProtocolError(-32602, '输入不能为空')
  return [...(text.trim() ? [{ type: 'text', text }] : []), ...images]
}

// 客户端发来的输入里要记下来的那一份（见 DshServer.remember）：回给客户端的用户消息，内容就是它，
// 发来是什么样回去就是什么样（图片带地址的还是带地址、本地文件还是那个路径，技能还是一项技能）。
// 只留协议里有的字段。到这里的输入已经过了 promptContent，类型都是认识的。
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
    // 剩下的是技能和文件引用，形状一样
    return { type: item.type, name: String(item.name ?? ''), path: String(item.path ?? '') }
  })
}
