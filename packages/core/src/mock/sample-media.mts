import type { FilePreview } from '../model-preview.mjs'
import { base64Bytes, textToBase64 } from '../text/bytes.mjs'
import { OUTSIDE_FILE_DATA } from './sample-file-links.mjs'

/** 固定验收图片，不访问网络或宿主文件；也供桌面隐藏窗口复用。 */
export function sampleImage(source: string): FilePreview | null {
  if (!source.includes('media-p1')) return null
  if (source.endsWith('oversize.png'))
    return { kind: 'tooLarge', path: source, bytes: 9 * 1024 ** 2, limit: 8 * 1024 ** 2 }
  if (source.endsWith('failed.png')) return { kind: 'invalid', path: source }
  const svg = source.endsWith('.svg')
  const dataBase64 = source.endsWith('broken.png')
    ? 'bm90LWFuLWltYWdl'
    : svg
      ? textToBase64(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#4179af"/><circle cx="160" cy="80" r="50" fill="#e5effa"/></svg>',
        )
      : (OUTSIDE_FILE_DATA['/tmp/litch-file-links/image.png'] ?? '')
  return {
    kind: 'ready',
    path: source,
    format: svg ? 'svg' : 'image',
    dataBase64,
    bytes: base64Bytes(dataBase64),
  }
}

export const MEDIA_REPLY =
  '![P1 图片](/work/media-p1/photo.png)\n\n![工作区外](/tmp/media-p1/photo.png)\n\n![外网图片](https://media-p1.example.invalid/photo.png)\n\n![SVG](/tmp/media-p1/vector.svg)\n\n![坏图](/tmp/media-p1/broken.png)\n\n![超限](/tmp/media-p1/oversize.png)\n\n![失败链接](https://media-p1.example.invalid/failed.png)\n\n[普通文件](./README.md)'
