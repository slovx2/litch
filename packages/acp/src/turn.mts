import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { AgentCapabilities } from './declaration.mjs'

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Codex 的输入换成 ACP 的 prompt 内容块。文字合成一段；技能写成打头的“/名字”（ACP 的斜杠命令就是这样发的，
 * agent 只认开头的）；提到的文件是资源链接（规范要求每个 agent 都收）；图片要 agent 声明了收图片才行。
 * 返回内容块和那段文字（回放时按这段文字找客户端当初发来的样子，见 AcpServer.remember）。
 */
export async function promptContent(
  input: unknown,
  caps: AgentCapabilities | null,
): Promise<{ blocks: any[]; text: string }> {
  if (!Array.isArray(input)) throw new ProtocolError(-32602, 'input 必须是数组')
  const parts: string[] = []
  const skills: string[] = []
  const links: any[] = []
  const images: any[] = []
  const image = (mimeType: string, data: string) => {
    if (!caps?.image) throw new ProtocolError(-32602, '这个 ACP agent 不收图片')
    images.push({ type: 'image', mimeType, data })
  }
  for (const item of input as any[]) {
    if (item?.type === 'text') parts.push(String(item.text ?? ''))
    else if (item?.type === 'skill') skills.push(`/${String(item.name ?? '')}`)
    else if (item?.type === 'mention') {
      const path = String(item.path ?? '')
      links.push({
        type: 'resource_link',
        uri: pathToFileURL(path).href,
        name: String(item.name || basename(path)),
      })
    } else if (item?.type === 'localImage') {
      const mimeType = MEDIA[extname(String(item.path ?? '')).toLowerCase()]
      if (!mimeType) throw new ProtocolError(-32602, `不支持的图片类型: ${item.path}`)
      image(mimeType, (await readFile(item.path)).toString('base64'))
    } else if (item?.type === 'image') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(String(item.url ?? ''))
      if (!match) throw new ProtocolError(-32602, 'ACP 的图片输入需要 data URL 或本地文件')
      image(match[1] as string, match[2] as string)
    } else throw new ProtocolError(-32602, `不支持输入类型: ${item?.type}`)
  }
  const body = parts.join('\n')
  const text = skills.length ? `${skills.join(' ')}${body ? ` ${body}` : ''}` : body
  if (!text.trim() && !images.length && !links.length)
    throw new ProtocolError(-32602, '输入不能为空')
  return { blocks: [...(text ? [{ type: 'text', text }] : []), ...links, ...images], text }
}

/**
 * 客户端发来的输入里要回给它的那一份（用户消息的内容）：发来是什么样回去就是什么样，只留协议里有的字段。
 * 到这里的输入已经过了 promptContent，类型都是认识的。
 */
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
