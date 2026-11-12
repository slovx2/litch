import { type FileContent, type FilePreview, PREVIEW_LIMIT, previewKind } from '@litch/core'
import { PDF_PAGES } from '../../../../../../packages/ui/src/files/preview/pdf/policy.ts'

export type MobilePreviewFormat = 'image' | 'svg' | 'pdf' | 'media'
export type PreviewFailure =
  | 'unsupported'
  | 'tooLarge'
  | 'invalid'
  | 'imageInvalid'
  | 'encrypted'
  | 'pages'
  | 'size'
  | 'timeout'
  | 'missing'
  | 'outside'
  | 'notFile'
  | 'changed'
  | 'busy'
  | 'failed'
  | 'mediaInvalid'
  | 'mediaDuration'
  | 'mediaSize'
  | 'mediaUnsupported'

/** SVG 也走离线静态子集；不因后缀掩盖文件已经消失或读取失败的事实。 */
export function mobilePreviewFormat(content: FileContent): MobilePreviewFormat | null {
  if (content.kind === 'text' && previewKind(content.path) === 'svg') return 'svg'
  if (content.kind !== 'binary' && content.kind !== 'tooLarge') return null
  const format = previewKind(content.path)
  return format === 'image' || format === 'svg' || format === 'pdf' || format === 'media'
    ? format
    : null
}

/** 核心检查后，进入 WebView 前再守一次传输预算，避免错误夹具/设备把超大字符串送给渲染器。 */
export function previewFailure(
  result: FilePreview,
  format: MobilePreviewFormat,
): PreviewFailure | null {
  if (result.kind !== 'ready')
    return format === 'media' && result.kind === 'invalid' ? 'mediaInvalid' : result.kind
  const limit = PREVIEW_LIMIT[format]
  if (result.bytes > limit || result.dataBase64.length > Math.ceil(limit / 3) * 4) return 'tooLarge'
  if (result.format !== format || result.bytes < 1) return 'invalid'
  return null
}

export type PreviewEvent =
  | { kind: 'ready'; page: number; pages: number }
  | { kind: 'failed'; reason: PreviewFailure }

/** WebView 的消息只接收渲染状态，不接收文件地址、脚本或导航指令。 */
export function previewEvent(raw: string): PreviewEvent | null {
  try {
    const value = JSON.parse(raw)
    if (
      value.kind === 'ready' &&
      Number.isInteger(value.page) &&
      Number.isInteger(value.pages) &&
      value.page >= 1 &&
      value.page <= value.pages &&
      value.pages <= PDF_PAGES
    )
      return { kind: 'ready', page: value.page, pages: value.pages }
    if (
      value.kind === 'failed' &&
      ['invalid', 'imageInvalid', 'encrypted', 'pages', 'size', 'timeout'].includes(value.reason)
    )
      return { kind: 'failed', reason: value.reason }
  } catch {
    /* 无效消息不进入界面状态。 */
  }
  return null
}
