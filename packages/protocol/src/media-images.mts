export const MEDIA_IMAGES_EXTENSION = 'mediaImages'
export const MEDIA_IMAGE_METHOD = 'litch/media/readImage'
export const IMAGE_BYTES = 8 * 1024 * 1024
export const SVG_BYTES = 1024 * 1024
export type ImageReadResult =
  | { kind: 'ready'; format: 'image' | 'svg'; dataBase64: string; bytes: number }
  | { kind: 'unsupported' | 'missing' | 'invalid' | 'notFile' | 'changed' | 'busy' }
  | { kind: 'tooLarge'; bytes: number; limit: number }

/** 只作有界探测；尺寸、完整结构和 SVG 静态子集在客户端解码前再验证。 */
export function imageFormat(bytes: Uint8Array): 'image' | 'svg' | null {
  const head = String.fromCharCode(...bytes.subarray(0, 16))
  if (
    head.startsWith('\x89PNG\r\n\x1a\n') ||
    head.startsWith('\xff\xd8\xff') ||
    /^GIF8[79]a/.test(head) ||
    (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
  )
    return 'image'
  const text = String.fromCharCode(...bytes.subarray(0, 4096))
    .replace(/^\xef\xbb\xbf/, '')
    .trimStart()
  return /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text) ? 'svg' : null
}
