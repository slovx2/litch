import { decodeBase64, type FilePreview, PREVIEW_LIMIT } from '@litch/core'
import { imageInfo, svgInfo } from './image-info.ts'

/** 文件面板、正文和手机离线视口共用的解码前预算。SVG 必须在有 DOMParser 的隔离图像上下文验证。 */
export function checkedImage(data: Extract<FilePreview, { kind: 'ready' }>) {
  const limit = data.format === 'svg' ? PREVIEW_LIMIT.svg : PREVIEW_LIMIT.image
  if (data.bytes < 1 || data.bytes > limit || data.dataBase64.length > Math.ceil(limit / 3) * 4)
    return null
  try {
    const bytes = decodeBase64(data.dataBase64)
    if (bytes.length !== data.bytes) return null
    const info = data.format === 'svg' ? svgInfo(new TextDecoder().decode(bytes)) : imageInfo(bytes)
    return info ? { bytes, info } : null
  } catch {
    return null
  }
}
