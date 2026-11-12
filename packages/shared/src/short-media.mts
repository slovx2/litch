import { SHORT_MEDIA_BYTES } from '../../protocol/src/file-preview.mjs'
import { readPreview } from './file-preview.mjs'
import { ProtocolError } from './protocol-contract.mjs'

/** 文件页与后续对话媒体复用同一条有界读取；只返回已经探测为媒体的内容。 */
export async function readShortMedia(path: string, raw: unknown) {
  const limit = (raw as { maxBytes?: unknown } | null)?.maxBytes
  if (typeof limit !== 'number' || limit > SHORT_MEDIA_BYTES)
    throw new ProtocolError(-32602, '短媒体读取预算无效')
  try {
    return await readPreview(path, raw, 'media')
  } catch (error) {
    const reason = (error as { data?: { litchPreview?: unknown } }).data?.litchPreview
    if (reason) Object.assign(error as object, { data: { litchShortMedia: reason } })
    throw error
  }
}
