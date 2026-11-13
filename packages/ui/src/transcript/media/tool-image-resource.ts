import type { FilePreview } from '@litch/core'
import { checkedImage } from '../../files/preview/image-resource.ts'

/** 缩略图菜单按现有预览预算读取原图，不把缓存标识当成文件路径。 */
export async function loadToolImage(read: () => Promise<FilePreview>, unavailable: string) {
  const content = await read()
  const parsed = content.kind === 'ready' ? checkedImage(content) : null
  if (!parsed) throw new Error(unavailable)
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(parsed.bytes)], { type: parsed.info.mime }),
  )
  return {
    image: { url, width: parsed.info.width, height: parsed.info.height },
    release: () => URL.revokeObjectURL(url),
  }
}
